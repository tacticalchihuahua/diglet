'use strict';

const async = require('async');
const secp256k1 = require('secp256k1');
const crypto = require('crypto');
const merge = require('merge');
const assert = require('assert');
const net = require('net');
const tls = require('tls');
const { Transform } = require('stream');
const { createLogger } = require('bunyan');
const { randomBytes } = require('crypto');
const { EventEmitter } = require('events');
const https = require('https');
const Handshake = require('./handshake');

/** Manages a group of connections that compose a tunnel */
class Tunnel extends EventEmitter {

  static get DEFAULTS() {
    return {
      maxConnections: 24,
      logger: createLogger({ name: 'diglet' }),
      transform: function(data, enc, cb) {
        cb(null, data)
      },
      privateKey: randomBytes(32),
      secureLocalConnection: false,
      autoReconnect: true,
      autoReconnectInterval: 30000
    };
  }

  /**
   * Create a tunnel
   * @param {object} options
   * @param {string} options.localAddress - The local IP or hostname to expose
   * @param {number} options.localPort - The local port to expose
   * @param {string} options.remoteAddress - The remote tunnel address
   * @param {number} options.remotePort - The remote tunnel port
   * @param {number} [options.maxConnections=24] - Total connections to maintain
   * @param {object} [options.logger=console] - Logger to use
   * @param {stream.Transform} [options.transform] - Transform stream for
   * manipulating incoming proxied stream
   */
  constructor(options) {
    super();
    this.setMaxListeners(0);

    this._opts = this._checkOptions(merge(Tunnel.DEFAULTS, options));
    this._logger = this._opts.logger;
    this._pool = new Set();

    this.on('open', tunnel => this._handleTunnelOpen(tunnel));
  }

  /**
   * Validates options given to constructor
   * @private
   */
  _checkOptions(o) {
    assert(typeof o.localAddress === 'string', 'Invalid localAddress');
    assert(typeof o.localPort === 'number', 'Invalid localPort');
    assert(typeof o.remoteAddress === 'string', 'Invalid remoteAddress');
    assert(typeof o.remotePort === 'number', 'Invalid remotePort');
    assert(typeof o.maxConnections === 'number', 'Invalid maxConnections');
    return o;
  }

  aliasUrl(alias) {
    return `https://${alias}.${this._opts.remoteAddress}`;
  }

  /**
   * Gets the appropriate tunnel URL
   * @returns {string}
   */
  get url() {
    return `https://${this.id}.${this._opts.remoteAddress}`;
  }

  get id() {
    const pubkey = secp256k1.publicKeyCreate(this._opts.privateKey);
    const id = crypto.createHash('ripemd160')
      .update(crypto.createHash('sha256').update(pubkey).digest())
      .digest('hex');

    return id;
  }

  /**
   * Establishes the tunnel connection
   */
  open(n) {
    return new Promise((resolve, reject) => {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;

      const t = n || (this._opts.maxConnections - this._pool.size);

      this._logger.info(
        'establishing %s connections to %s:%s',
        t,
        this._opts.remoteAddress,
        this._opts.remotePort
      );

      async.times(t, async (i) => {
        this._logger.debug('creating remote connection %s', i);
        try {
          await this._createLocalConnection(
            await this._createRemoteConnection()
          );
        } catch (err) {
          return Promise.reject(err);
        }
        return Promise.resolve();
      }, err => {
        if (err) {
          this._reconnect();
          return reject(err);
        }

        this.reconnect();
        resolve();
      });
    });
  }

  /**
   * Sets up listeners and tracks status of a given tunnel
   * @private
   */
  _handleTunnelOpen(tunnelConnection) {
    this._logger.debug('a tunnel connection was opened');

    const _handleClose = () => {
      this._logger.warn('all tunnel connections were closed');
      tunnelConnection.destroy();
    };

    const _handleTunnelClose = () => {
      this._logger.debug('a tunnel connection was closed');
      this.removeListener('close', _handleClose);
    };

    this.once('close', _handleClose);
    tunnelConnection.once('close', _handleTunnelClose);
  }

  /**
   * Connects out to the remote proxy
   * @private
   */
  _createRemoteConnection() {
    return new Promise((resolve, reject) => {
      const remoteConnection = tls.connect({
        host: this._opts.remoteAddress,
        port: this._opts.remotePort,
        rejectUnauthorized: false // so we can use the same cert for the proxy
      });

      // remoteConnection.setKeepAlive(true);
      // remoteConnection.setNoDelay(true);

      remoteConnection.on('error', err => {
        this._logger.error('error with remote connection: %s', err.message);
        this._handleRemoteError(remoteConnection, err);
        this._pool.delete(remoteConnection);
        reject(err);
      });

      remoteConnection.once('connect', () => {
        this._logger.info('remote connection established, awaiting challenge');
        this._pool.add(remoteConnection);
      });

      remoteConnection.on('close', () => {
        this._logger.info('remote connection closed');
        this._pool.delete(remoteConnection);
      });

      remoteConnection.once('data', data => {
        this._logger.info('received challenge, signing handshake');
        remoteConnection.write(
          Handshake.from(data).sign(this._opts.privateKey).toBuffer()
        );
        resolve(remoteConnection);
      });
    });
  }

  /**
   * Opens the connection to the local server
   * @private
   */
  _createLocalConnection(remoteConnection) {
    return new Promise((resolve, reject) => {
      const proto = this._opts.secureLocalConnection
        ? tls
        : net;

      this._logger.debug('creating local connection...');

      var localConnection = proto.connect({
        host: this._opts.localAddress,
        port: this._opts.localPort,
        rejectUnauthorized: false // so local servers can self-sign
      });

      remoteConnection.pause();

      remoteConnection.once('close', () => {
        this._logger.info('remote connection closed, ending local connection');
        localConnection.end();
        this._logger.info('reopening remote tunnel connection');
        this.open(1);
      });

      localConnection.once('error', err => {
        this._handleLocalError(err, localConnection, remoteConnection);
        reject();
      });

      localConnection.once('connect', () => {
        this._handleLocalOpen(localConnection, remoteConnection);
        resolve();
      });
    });
  }

  /**
   * Handles errors from the local server
   * @private
   */
  _handleLocalError(err, localConnection, remoteConnection) {
    this._logger.error('local connection error: %s', err.message);
    localConnection.end();
    remoteConnection.end();
  }

  /**
   * Connects the local and remote sockets to create tunnel
   * @private
   */
  _handleLocalOpen(localConnection, remoteConnection) {
    let stream = remoteConnection;

    if (this._opts.localAddress !== 'localhost') {
      stream = remoteConnection.pipe(this._transformHeaders());
    }

    stream = stream.pipe(new Transform({ transform: this._opts.transform }));

    this._logger.info('connecting local and remote connections');
    stream.pipe(localConnection).pipe(remoteConnection);
    this.emit('connected');
  }

  /**
   * Transforms the host header
   * @private
   */
  _transformHeaders() {
    let replaced = false;

    return new Transform({
      transform: (chunk, enc, cb) => {
        if (replaced) {
          return cb(null, chunk);
        }

        chunk = chunk.toString();

        cb(null, chunk.replace(/(\r\nHost: )\S+/, (match, $1) => {
          replaced = true;
          return $1 + this._opts.localAddress;
        }));
      }
    });
  }

  /**
   * Handles errors from the remote proxy
   * @private
   */
  _handleRemoteError(remoteConnection, err) {
    if (err.code === 'ECONNREFUSED') {
      this._pool.delete(remoteConnection);
      this.emit('disconnected', new Error('Tunnel connection refused'));
    }

    this._logger.error('remote connection encountered error: %s', err.message);
    remoteConnection.end();
    remoteConnection.destroy();

    const shouldReconnect = this._pool.size === 0 && !this._reconnectTimeout;

    if (this._opts.autoReconnect && shouldReconnect) {
      this._logger.error(`reconnect in ${this._opts.autoReconnectInterval}ms`);
      this._reconnectTimeout = setTimeout(() => this.open(),
        this._opts.autoReconnectInterval);
    } else if (this._opts.autoReconnect) {
      this._logger.error('waiting on an active reconnection attempt');
    } else {
      this._logger.error('will not try to reconnect');
    }
  }

  /**
   * Kick off the auto reconnect heartbeat
   */
  reconnect() {
    clearTimeout(this._reconnectTimeout);
    this._reconnectTimeout = setTimeout(async () => {
      await this._reconnect();
      this.reconnect();
    }, this._opts.autoReconnectInterval);
  }

  /**
   * @private
   */
  _reconnect() {
    return new Promise(async (resolve) => {
      await this.close();
      await this.open();
      resolve();
    });
  }

  /**
   * Shutsdown the tunnel
   */
  close() {
    return new Promise(resolve => {
      async.each(this._pool, (sock, done) => {
        sock.removeAllListeners('close');
        sock.removeAllListeners('error');
        sock.end(() => {
          sock.destroy();
          this._pool.delete(sock);
          done();
        });
      }, resolve);
    });
  }

  /**
   * Requests and returns server assigned info for this tunnel
   * @returns {Promise<object>}
   */
  queryProxyInfoFromServer(opts = {}) {
    let requestOptions = {
      hostname: this._opts.remoteAddress,
      path: `/${this.id}`,
      protocol: 'https:',
      headers: {
        'Accept': 'application/json'
      },
      ...opts
    };

    return new Promise((resolve, reject) => {
      const req = https.request(requestOptions, (res) => {
        let body = '';

        res.on('data', data => body += data.toString());
        res.on('end', () => {
          try {
            body = JSON.parse(body);
          } catch (err) {
            reject(err);
          }

          if (res.statusCode === 200) {
            resolve(body);
          } else {
            reject(new Error(body.message));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = Tunnel;
