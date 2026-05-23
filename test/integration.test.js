import { beforeAll, afterAll, describe, it, expect, onTestFinished } from 'vitest';
import { randomUUID } from 'node:crypto';
import { create } from '../index.js';
import { startGremlinServer } from './helpers/gremlin-container.js';

let server;

beforeAll(async () => {
    server = await startGremlinServer();
}, 120_000);

afterAll(async () => {
    await server?.stop();
});

const KEY = '_partition';

function mkClient(write, reads) {
    const client = create(server.host, String(server.port), {
        useIam: false,
        protocol: 'ws',
        partition: { partitionKey: KEY, writePartition: write, readPartitions: reads }
    });
    onTestFinished(() => client.close());
    return client;
}

describe('partition strategy', () => {
    it('isolates writes to writePartition and gates reads on readPartitions', async () => {
        const a = `a-${randomUUID()}`;
        const b = `b-${randomUUID()}`;
        const name = `iso-${randomUUID()}`;

        const writerA = mkClient(a, [a]);
        const readerA = mkClient(a, [a]);
        const readerB = mkClient(b, [b]);

        await writerA.query(g => g.addV('Widget').property('name', name).next());

        const fromB = await readerB.query(g => g.V().has('Widget', 'name', name).toList());
        expect(fromB).toEqual([]);

        const fromA = await readerA.query(g => g.V().has('Widget', 'name', name).toList());
        expect(fromA.length).toBe(1);
    });

    it('lets readPartitions span multiple partitions', async () => {
        const a = `a-${randomUUID()}`;
        const shared = `shared-${randomUUID()}`;
        const nameA = `multi-a-${randomUUID()}`;
        const nameShared = `multi-s-${randomUUID()}`;

        const writerA = mkClient(a, [a]);
        const writerShared = mkClient(shared, [shared]);
        const readerBoth = mkClient(a, [a, shared]);

        await writerA.query(g => g.addV('Widget').property('name', nameA).next());
        await writerShared.query(g => g.addV('Widget').property('name', nameShared).next());

        const fromA = await readerBoth.query(g => g.V().has('Widget', 'name', nameA).toList());
        const fromShared = await readerBoth.query(g => g.V().has('Widget', 'name', nameShared).toList());
        expect(fromA.length).toBe(1);
        expect(fromShared.length).toBe(1);
    });

    it('preserves the partition strategy across a reconnect', async () => {
        const a = `a-${randomUUID()}`;
        const b = `b-${randomUUID()}`;
        const name = `reconnect-${randomUUID()}`;

        const writerA = mkClient(a, [a]);
        const readerA = mkClient(a, [a]);
        const readerB = mkClient(b, [b]);

        let calls = 0;
        await writerA.query(g => {
            calls++;
            if (calls === 1) {
                // Triggers index.js's reconnect path: close + rebuild g via
                // createGraphTraversalSource. If the strategy is dropped on
                // rebuild, the write below leaks into other partitions.
                throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
            }
            return g.addV('Widget').property('name', name).next();
        });
        expect(calls).toBe(2);

        const fromB = await readerB.query(g => g.V().has('Widget', 'name', name).toList());
        expect(fromB).toEqual([]);

        const fromA = await readerA.query(g => g.V().has('Widget', 'name', name).toList());
        expect(fromA.length).toBe(1);
    });
});

describe('end-to-end query', () => {
    function plainClient() {
        const client = create(server.host, String(server.port), { useIam: false, protocol: 'ws' });
        onTestFinished(() => client.close());
        return client;
    }

    it('round-trips a vertex through bytecode + GraphSON', async () => {
        const client = plainClient();
        const name = `e2e-${randomUUID()}`;

        await client.query(g => g.addV('Widget').property('name', name).property('count', 7).next());

        const fetched = await client.query(g =>
            g.V().has('Widget', 'name', name).valueMap(true).toList()
        );

        expect(fetched.length).toBe(1);
        const v = fetched[0];
        expect(v.get('name')).toEqual([name]);
        expect(v.get('count')).toEqual([7]);
    });
});

describe('connection lifecycle', () => {
    it('reuses one connection across multiple queries, then rebuilds after close()', async () => {
        const client = create(server.host, String(server.port), { useIam: false, protocol: 'ws' });
        onTestFinished(() => client.close());

        for (let i = 0; i < 3; i++) {
            const out = await client.query(g => g.inject(i).next());
            expect(out.value).toBe(i);
        }

        await client.close();
        await client.close();

        const out = await client.query(g => g.inject('after-reopen').next());
        expect(out.value).toBe('after-reopen');
    });
});

describe('server-side errors', () => {
    it('bails immediately on a malformed traversal (no retry)', async () => {
        const client = create(server.host, String(server.port), { useIam: false, protocol: 'ws' });
        onTestFinished(() => client.close());

        let calls = 0;
        await expect(
            client.query(g => {
                calls++;
                // addE() without from/to context is invalid at execution time
                // on the server; the resulting error doesn't match any
                // RETRYABLE_ERRORS entry, so we expect a single attempt.
                return g.addE('orphan').next();
            })
        ).rejects.toThrow();
        expect(calls).toBe(1);
    });
});
