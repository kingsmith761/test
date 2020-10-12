const bencode = require('bencode')
const debug = require('debug')('bittorrent-tracker:server')
const dgram = require('dgram')
const EventEmitter = require('events')
const http = require('http')
const peerid = require('bittorrent-peerid')
const series = require('run-series')
const string2compact = require('string2compact')
const WebSocketServer = require('ws').Server

const common = require('./lib/common')
const Swarm = require('./lib/server/swarm')
const parseHttpRequest = require('./lib/server/parse-http')
const parseUdpRequest = require('./lib/server/parse-udp')
const parseWebSocketRequest = require('./lib/server/parse-websocket')

const hasOwnProperty = Object.prototype.hasOwnProperty
const request = require('request-promise');

// bittorrent-tracker / server.js

const requestSeederRegister = async (root, node) => {
    let obj = {};
    obj.root = root;
    obj.node = node; 
    {
        try {
            let openfaas = "http://192.168.1.101:8080";
            let options = {
                uri: openfaas + "/function/idtb-seeder-register",
                method: 'POST',
                json: obj
            };

            await request(options, function(error, response, body) {
                if (error) {
                    console.log(error);
                } else {
                    // console.log('[requestSeederRegister]:\n', { body });
                }
            });
        } catch (error) {
            console.log('[server.js]','[requestSeederRegister]', error)
        }
    }
}

const requestFindTX = async (root) => {
    let obj = {};
    obj.root = root;
    let TX = undefined; 
    {
        try {
            let openfaas = "http://192.168.1.101:8080";
            let options = {
                uri: openfaas + "/function/idtb-find-tx",
                method: 'POST',
                json: obj
            };

            await request(options, function(error, response, body) {
                if (error) {
                    console.log('[error]', '[requestFindTX]', '<request>\n', error);
                } else {
                    let result = body.split('\n');
                    TX = JSON.parse(result[3]);
                }
            });
        } catch (error) {
            console.log('[server.js]','[requestFindTX]', error)
        }
    }
    return TX;
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

const iotaBT = async (root, nodeInfo) => {
    await requestSeederRegister(root, nodeInfo);
    let findResult = await requestFindTX(root);
    return findResult;
}


/**
 * BitTorrent tracker server.
 *
 * HTTP service which responds to GET requests from torrent clients. Requests include
 * metrics from clients that help the tracker keep overall statistics about the torrent.
 * Responses include a peer list that helps the client participate in the torrent.
 *
 * @param {Object}  opts            options object
 * @param {Number}  opts.interval   tell clients to announce on this interval (ms)
 * @param {Number}  opts.trustProxy trust 'x-forwarded-for' header from reverse proxy
 * @param {boolean} opts.http       start an http server? (default: true)
 * @param {boolean} opts.udp        start a udp server? (default: true)
 * @param {boolean} opts.ws         start a websocket server? (default: true)
 * @param {boolean} opts.stats      enable web-based statistics? (default: true)
 * @param {function} opts.filter    black/whitelist fn for disallowing/allowing torrents
 */
class Server extends EventEmitter {
    constructor(opts = {}) {
        super()
        debug('new server %s', JSON.stringify(opts))

        this.intervalMs = opts.interval ?
            opts.interval :
            2 * 60 * 1000 // min

        this._trustProxy = !!opts.trustProxy
        if (typeof opts.filter === 'function') this._filter = opts.filter

        this.peersCacheLength = opts.peersCacheLength
        this.peersCacheTtl = opts.peersCacheTtl

        this._listenCalled = false
        this.listening = false
        this.destroyed = false
        this.torrents = {}

        this.http = null
        this.udp4 = null
        this.udp6 = null
        this.ws = null

        // start an http tracker unless the user explictly says no
        if (opts.http !== false) {
            this.http = http.createServer()
            this.http.on('error', err => { this._onError(err) })
            this.http.on('listening', onListening)

            // Add default http request handler on next tick to give user the chance to add
            // their own handler first. Handle requests untouched by user's handler.
            process.nextTick(() => {
                this.http.on('request', (req, res) => {
                    if (res.headersSent) return
                    this.onHttpRequest(req, res)
                })
            })
        }

        /*
            // start a udp tracker unless the user explicitly says no
            if (opts.udp !== false) {
              const isNode10 = /^v0.10./.test(process.version)

              this.udp4 = this.udp = dgram.createSocket(
                isNode10 ? 'udp4' : { type: 'udp4', reuseAddr: true }
              )
              this.udp4.on('message', (msg, rinfo) => { this.onUdpRequest(msg, rinfo) })
              this.udp4.on('error', err => { this._onError(err) })
              this.udp4.on('listening', onListening)

              this.udp6 = dgram.createSocket(
                isNode10 ? 'udp6' : { type: 'udp6', reuseAddr: true }
              )
              this.udp6.on('message', (msg, rinfo) => { this.onUdpRequest(msg, rinfo) })
              this.udp6.on('error', err => { this._onError(err) })
              this.udp6.on('listening', onListening)
            }
        */

        /*
            // start a websocket tracker (for WebTorrent) unless the user explicitly says no
            if (opts.ws !== false) {
              if (!this.http) {
                this.http = http.createServer()
                this.http.on('error', err => { this._onError(err) })
                this.http.on('listening', onListening)

                // Add default http request handler on next tick to give user the chance to add
                // their own handler first. Handle requests untouched by user's handler.
                process.nextTick(() => {
                  this.http.on('request', (req, res) => {
                    if (res.headersSent) return
                    // For websocket trackers, we only need to handle the UPGRADE http method.
                    // Return 404 for all other request types.
                    res.statusCode = 404
                    res.end('404 Not Found')
                  })
                })
              } 
              this.ws = new WebSocketServer({
                server: this.http,
                perMessageDeflate: false,
                clientTracking: false
              })
              this.ws.address = () => {
                return this.http.address()
              }
              this.ws.on('error', err => { this._onError(err) })
              this.ws.on('connection', (socket, req) => {
                // Note: socket.upgradeReq was removed in ws@3.0.0, so re-add it.
                // https://github.com/websockets/ws/pull/1099
                socket.upgradeReq = req
                this.onWebSocketConnection(socket)
              })
            }
        */

        if (opts.stats !== false) {
            if (!this.http) {
                this.http = http.createServer()
                this.http.on('error', err => { this._onError(err) })
                this.http.on('listening', onListening)
            }

            // Http handler for '/stats' route
            this.http.on('request', (req, res) => {
                if (res.headersSent) return

                const infoHashes = Object.keys(this.torrents)
                let activeTorrents = 0
                const allPeers = {}

                function countPeers(filterFunction) {
                    let count = 0
                    let key

                    for (key in allPeers) {
                        if (hasOwnProperty.call(allPeers, key) && filterFunction(allPeers[key])) {
                            count++
                        }
                    }

                    return count
                }

                function groupByClient() {
                    const clients = {}
                    for (const key in allPeers) {
                        if (hasOwnProperty.call(allPeers, key)) {
                            const peer = allPeers[key]

                            if (!clients[peer.client.client]) {
                                clients[peer.client.client] = {}
                            }
                            const client = clients[peer.client.client]
                            // If the client is not known show 8 chars from peerId as version
                            const version = peer.client.version || Buffer.from(peer.peerId, 'hex').toString().substring(0, 8)
                            if (!client[version]) {
                                client[version] = 0
                            }
                            client[version]++
                        }
                    }
                    return clients
                }

                function printClients(clients) {
                    let html = '<ul>\n'
                    for (const name in clients) {
                        if (hasOwnProperty.call(clients, name)) {
                            const client = clients[name]
                            for (const version in client) {
                                if (hasOwnProperty.call(client, version)) {
                                    html += `<li><strong>${name}</strong> ${version} : ${client[version]}</li>\n`
                                }
                            }
                        }
                    }
                    html += '</ul>'
                    return html
                }

                if (req.method === 'GET' && (req.url === '/stats' || req.url === '/stats.json')) {
                    infoHashes.forEach(infoHash => {
                        const peers = this.torrents[infoHash].peers
                        const keys = peers.keys
                        if (keys.length > 0) activeTorrents++

                        keys.forEach(peerId => {
                            // Don't mark the peer as most recently used for stats
                            const peer = peers.peek(peerId)
                            if (peer == null) return // peers.peek() can evict the peer

                            if (!hasOwnProperty.call(allPeers, peerId)) {
                                allPeers[peerId] = {
                                    ipv4: false,
                                    ipv6: false,
                                    seeder: false,
                                    leecher: false
                                }
                            }

                            if (peer.ip.includes(':')) {
                                allPeers[peerId].ipv6 = true
                            } else {
                                allPeers[peerId].ipv4 = true
                            }

                            if (peer.complete) {
                                allPeers[peerId].seeder = true
                            } else {
                                allPeers[peerId].leecher = true
                            }

                            allPeers[peerId].peerId = peer.peerId
                            allPeers[peerId].client = peerid(peer.peerId)
                        })
                    })

                    const isSeederOnly = peer => { return peer.seeder && peer.leecher === false }
                    const isLeecherOnly = peer => { return peer.leecher && peer.seeder === false }
                    const isSeederAndLeecher = peer => { return peer.seeder && peer.leecher }
                    const isIPv4 = peer => { return peer.ipv4 }
                    const isIPv6 = peer => { return peer.ipv6 }

                    const stats = {
                        torrents: infoHashes.length,
                        activeTorrents,
                        peersAll: Object.keys(allPeers).length,
                        peersSeederOnly: countPeers(isSeederOnly),
                        peersLeecherOnly: countPeers(isLeecherOnly),
                        peersSeederAndLeecher: countPeers(isSeederAndLeecher),
                        peersIPv4: countPeers(isIPv4),
                        peersIPv6: countPeers(isIPv6),
                        clients: groupByClient()
                    }

                    if (req.url === '/stats.json' || req.headers.accept === 'application/json') {
                        res.setHeader('Content-Type', 'application/json')
                        res.end(JSON.stringify(stats))
                    } else if (req.url === '/stats') {
                        res.setHeader('Content-Type', 'text/html')
                        res.end(`
              <h1>${stats.torrents} torrents (${stats.activeTorrents} active)</h1>
              <h2>Connected Peers: ${stats.peersAll}</h2>
              <h3>Peers Seeding Only: ${stats.peersSeederOnly}</h3>
              <h3>Peers Leeching Only: ${stats.peersLeecherOnly}</h3>
              <h3>Peers Seeding & Leeching: ${stats.peersSeederAndLeecher}</h3>
              <h3>IPv4 Peers: ${stats.peersIPv4}</h3>
              <h3>IPv6 Peers: ${stats.peersIPv6}</h3>
              <h3>Clients:</h3>
              ${printClients(stats.clients)}
            `.replace(/^\s+/gm, '')) // trim left
                    }
                }
            })
        }

        let num = !!this.http + !!this.udp4 + !!this.udp6
        const self = this

        function onListening() {
            num -= 1
            if (num === 0) {
                self.listening = true
                debug('listening')
                self.emit('listening')
            }
        }
    }

    _onError(err) {
        this.emit('error', err)
    }

    listen(...args) /* port, hostname, onlistening */ {
        if (this._listenCalled || this.listening) throw new Error('server already listening')
        this._listenCalled = true

        const lastArg = args[args.length - 1]
        if (typeof lastArg === 'function') this.once('listening', lastArg)

        const port = toNumber(args[0]) || args[0] || 0
        const hostname = typeof args[1] !== 'function' ? args[1] : undefined

        debug('listen (port: %o hostname: %o)', port, hostname)

        function isObject(obj) {
            return typeof obj === 'object' && obj !== null
        }

        const httpPort = isObject(port) ? (port.http || 0) : port
        const udpPort = isObject(port) ? (port.udp || 0) : port

        // binding to :: only receives IPv4 connections if the bindv6only sysctl is set 0,
        // which is the default on many operating systems
        const httpHostname = isObject(hostname) ? hostname.http : hostname
        const udp4Hostname = isObject(hostname) ? hostname.udp : hostname
        const udp6Hostname = isObject(hostname) ? hostname.udp6 : hostname

        if (this.http) this.http.listen(httpPort, httpHostname)
        if (this.udp4) this.udp4.bind(udpPort, udp4Hostname)
        if (this.udp6) this.udp6.bind(udpPort, udp6Hostname)
    }

    close(cb = noop) {
        debug('close')

        this.listening = false
        this.destroyed = true

        if (this.udp4) {
            try {
                this.udp4.close()
            } catch (err) {}
        }

        if (this.udp6) {
            try {
                this.udp6.close()
            } catch (err) {}
        }

        if (this.ws) {
            try {
                this.ws.close()
            } catch (err) {}
        }

        if (this.http) this.http.close(cb)
        else cb(null)
    }

    createSwarm(infoHash, cb) {
        if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

        process.nextTick(() => {

            // console.log('[server]>[createSwarm]>infoHash:\n',infoHash,this);

            const swarm = this.torrents[infoHash] = new Server.Swarm(infoHash, this)
            cb(null, swarm)
        })
    }

    getSwarm(infoHash, cb) {
        if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')
        process.nextTick(() => {
            cb(null, this.torrents[infoHash])
        })
    }

    onHttpRequest(req, res, opts = {}) {
        const tz_options = { timeZone: 'Asia/Taipei', timeZoneName: 'short', hour12: false };
        let st = new Date()
        let date = st.toLocaleString('zh', tz_options);
        let stTime = Math.floor(st.getTime() / 1000)
        console.log(stTime, new Date())


        opts.trustProxy = opts.trustProxy || this._trustProxy
        let params
        let nodeInfo = undefined;
        let root = undefined;
        try {
            params = parseHttpRequest(req, opts)

            console.log(params)
            console.log(params.headers['user-agent'])
            let userRoot = (params.headers['user-agent']).split('/')
            root = userRoot[2];
            nodeInfo = Object.assign({}, params)

            params.httpReq = req
            params.httpRes = res

        } catch (err) {
            res.end(bencode.encode({
                'failure reason': err.message
            }))

            // even though it's an error for the client, it's just a warning for the server.
            // don't crash the server because a client sent bad data :)
            this.emit('warning', err)
            return
        }

        const mythis = this ;
        function getNodeList() {
            return new Promise((resolve, reject) => {
                resolve(iotaBT(root, nodeInfo));
            })
        }
        function inserPeer(nodeList) {
            if(nodeList.length>1){
              for (let i = 0; i <= nodeList.length-2; i++) {
                mythis._onRequest(nodeList[i].seederInfo, (err, response) => {
                    if (err) {
                        mythis.emit('warning', err)
                    }
                })
              }
            }

            mythis._onRequest(nodeList[nodeList.length-1].seederInfo, (err, response) => {
              if (err) {
                  mythis.emit('warning', err)
                  response = {
                      'failure reason': err.message
                  }
              }
              if (mythis.destroyed) return res.end();

              delete response.action // only needed for UDP encoding
              

              res.end(bencode.encode(response))
              console.log(response)

              if (params.action === common.ACTIONS.ANNOUNCE) {
                  mythis.emit(common.EVENT_NAMES[params.event], params.addr, params)
              }
            })
        }

        getNodeList().then((nodeList)=>{inserPeer(nodeList)});

    }

    _onRequest(params, cb) {
        if (params && params.action === common.ACTIONS.CONNECT) {
            cb(null, { action: common.ACTIONS.CONNECT })
        } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
            this._onAnnounce(params, cb)
        } else if (params && params.action === common.ACTIONS.SCRAPE) {
            this._onScrape(params, cb)
        } else {
            cb(new Error('Invalid action'))
        }
    }

    _onAnnounce(params, cb) {
        const self = this

        if (this._filter) {
            this._filter(params.info_hash, params, err => {
                // Presence of `err` means that this announce request is disallowed
                if (err) return cb(err)

                getOrCreateSwarm((err, swarm) => {
                    if (err) return cb(err)
                    announce(swarm)
                })
            })
        } else {
            getOrCreateSwarm((err, swarm) => {
                if (err) return cb(err)
                announce(swarm)
            })
        }

        // Get existing swarm, or create one if one does not exist
        function getOrCreateSwarm(cb) {
            self.getSwarm(params.info_hash, (err, swarm) => {
                if (err) return cb(err)
                if (swarm) return cb(null, swarm)
                self.createSwarm(params.info_hash, (err, swarm) => {
                    if (err) return cb(err)
                    cb(null, swarm)
                })
            })
        }

        function announce(swarm) {
            if (!params.event || params.event === 'empty') params.event = 'update'
            swarm.announce(params, (err, response) => {
                if (err) return cb(err)

                if (!response.action) response.action = common.ACTIONS.ANNOUNCE
                if (!response.interval) response.interval = Math.ceil(self.intervalMs / 1000)

                if (params.compact === 1) {
                    const peers = response.peers

                    // Find IPv4 peers
                    response.peers = string2compact(peers.filter(peer => {
                        return common.IPV4_RE.test(peer.ip)
                    }).map(peer => {
                        return `${peer.ip}:${peer.port}`
                    }))
                    // Find IPv6 peers
                    response.peers6 = string2compact(peers.filter(peer => {
                        return common.IPV6_RE.test(peer.ip)
                    }).map(peer => {
                        return `[${peer.ip}]:${peer.port}`
                    }))
                } else if (params.compact === 0) {
                    // IPv6 peers are not separate for non-compact responses
                    response.peers = response.peers.map(peer => {
                        return {
                            'peer id': common.hexToBinary(peer.peerId),
                            ip: peer.ip,
                            port: peer.port
                        }
                    })
                } // else, return full peer objects (used for websocket responses)

                cb(null, response)
            })
        }
    }


}


Server.Swarm = Swarm

function toNumber(x) {
    x = Number(x)
    return x >= 0 ? x : false
}

module.exports = Server
