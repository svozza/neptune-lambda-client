const aws4 = require('aws4');
const gremlin = require('gremlin');
const retry = require('async-retry');

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const {driver: {DriverRemoteConnection}} = gremlin;

const RETRYABLE_ERRORS = ['ConcurrentModificationException', 'ReadOnlyViolationException'];

function createHeaders(host, port, path, options) {
    if (!host || !port) {
        throw new Error('Host and port are required');
    }

    const accessKeyId = options.accessKey || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = options.secretKey || process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = options.sessionToken || process.env.AWS_SESSION_TOKEN;
    const region = options.region || process.env.AWS_REGION;

    if (!accessKeyId || !secretAccessKey || !region) {
        throw new Error(
            'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION are required'
        );
    }

    const sigOptions = {
        host: `${host}:${port}`,
        region,
        path,
        service: 'neptune-db',
    };

    return aws4.sign(sigOptions, {
        accessKeyId, secretAccessKey, sessionToken,
    }).headers;
}

module.exports = {
    create: function(host, port, {useIam = true, protocol = 'wss'} = {}) {
        let conn = null;
        let g = null;

        const path = "/gremlin"
        const url = `${protocol}://${host}:${port}${path}`

        const createRemoteConnection = () => {

            const c = new DriverRemoteConnection(
                url,
                {
                    // Lambda freezes between invocations; heartbeats fired just before freeze
                    // time out after thaw, causing noisy disconnects. Our reconnect-on-error path
                    // handles dead connections, so skip the liveness pings.
                    pingEnabled: false,
                    headers: useIam ? createHeaders(host, port, path, {}) : {}
                });

            // gremlin opens the WebSocket eagerly on construction; swallow a potential
            // orphan rejection here. The real error resurfaces on the next submit().
            c.open().catch(() => {});

            c._client._connection.on('log', message => {
                console.info(`connection message - ${message}`);
            });

            c._client._connection.on('close', (code, message) => {
                console.info(`close - ${code} ${message}`);
                if (code == 1006){
                    console.error('Connection closed prematurely');
                    throw new Error('Connection closed prematurely');
                }
            });

            return c;
        };

        const createGraphTraversalSource = conn => {
            return traversal().withRemote(conn);
        };

        return {
            query: async f => {
                if (conn == null){
                    console.info('Initializing connection')
                    conn = createRemoteConnection();
                    g = createGraphTraversalSource(conn);
                }

                return retry(async (bail, count) => {
                    return f(g).catch(err => {
                        if(count > 0) console.log('Retry attempt no: ' + count);
                        if (err.message.startsWith('WebSocket is not open')){
                            console.warn('Reopening connection');
                            conn.close();
                            conn = createRemoteConnection();
                            g = createGraphTraversalSource(conn);
                            throw err;
                        }
                        if (RETRYABLE_ERRORS.some(name => err.message.includes(name))) {
                            console.warn('Retrying query: ' + err.message);
                            throw err;
                        }
                        console.warn('Unrecoverable error: ' + err);
                        return bail(err);
                    })
                }, {
                    retries: 5,
                    factor: 2,
                    minTimeout: 1000,
                    maxTimeout: 10000,
                    randomize: true
                });
            },
            close: async () => {
                if (conn != null) {
                    await conn.close();
                    conn = null;
                    g = null;
                }
            }
        }
    }
}
