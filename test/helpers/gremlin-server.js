import { WebSocketServer } from 'ws';

export async function startFakeGremlin() {
    const upgrades = [];
    let resolveNextUpgrade;
    let nextUpgrade = new Promise(resolve => { resolveNextUpgrade = resolve; });

    const wss = new WebSocketServer({ port: 0, path: '/gremlin' });

    wss.on('connection', (_socket, request) => {
        const record = { headers: { ...request.headers }, url: request.url };
        upgrades.push(record);
        const resolve = resolveNextUpgrade;
        nextUpgrade = new Promise(r => { resolveNextUpgrade = r; });
        resolve(record);
    });

    await new Promise(resolve => wss.on('listening', resolve));
    const { port } = wss.address();

    return {
        port,
        upgrades,
        waitForNextUpgrade: () => nextUpgrade,
        close: () =>
            new Promise(resolve => {
                for (const client of wss.clients) client.close(1000, 'shutdown');
                wss.close(() => resolve());
            })
    };
}

