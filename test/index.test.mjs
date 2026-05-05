import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import gremlinClient from '../index.js';
import { startFakeGremlin } from './helpers/gremlin-server.mjs';

let server;

beforeEach(async () => {
    server = await startFakeGremlin();
});

afterEach(async () => {
    await server.close();
});

function createClient(opts = {}) {
    const client = gremlinClient.create('localhost', server.port, { useIam: false, protocol: 'ws', ...opts });
    onTestFinished(() => client.close());
    return client;
}

describe('create() / query()', () => {
    it('resolves with the user function result on the happy path', async () => {
        const client = createClient();
        const result = await client.query(async () => 42);
        expect(result).toBe(42);
    });

    describe('with faked retry timers', () => {
        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['setTimeout'] });
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('retries on ConcurrentModificationException and eventually succeeds', async () => {
            const client = createClient();
            let calls = 0;
            const p = client.query(async () => {
                calls++;
                if (calls < 3) throw new Error('ConcurrentModificationException');
                return 'ok';
            });
            await vi.runAllTimersAsync();
            expect(await p).toBe('ok');
            expect(calls).toBe(3);
        });

        it('retries on ReadOnlyViolationException and eventually succeeds', async () => {
            const client = createClient();
            let calls = 0;
            const p = client.query(async () => {
                calls++;
                if (calls < 2) throw new Error('ReadOnlyViolationException: stale primary');
                return 'ok';
            });
            await vi.runAllTimersAsync();
            expect(await p).toBe('ok');
            expect(calls).toBe(2);
        });

        it('reconnects when the error is "WebSocket is not open"', async () => {
            const client = createClient();
            let calls = 0;
            const p = client.query(async () => {
                calls++;
                if (calls === 1) throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
                return 'reconnected';
            });
            await vi.runAllTimersAsync();
            expect(await p).toBe('reconnected');
            expect(calls).toBe(2);

            // The new WebSocket handshake runs on real I/O; wait for it before asserting.
            vi.useRealTimers();
            await vi.waitFor(() => expect(server.upgrades.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
        });

        it('gives up after the retry cap', async () => {
            const client = createClient();
            let calls = 0;
            const p = client.query(async () => {
                calls++;
                throw new Error('ConcurrentModificationException always');
            });
            const assertion = expect(p).rejects.toThrow('ConcurrentModificationException');
            await vi.runAllTimersAsync();
            await assertion;
            expect(calls).toBe(6);
        });
    });

    it('does not retry on unrecoverable errors', async () => {
        const client = createClient();
        let calls = 0;
        await expect(
            client.query(async () => {
                calls++;
                throw new Error('some random failure');
            })
        ).rejects.toThrow('some random failure');
        expect(calls).toBe(1);
    });
});

describe('IAM signing', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('sends a SigV4-signed Authorization header when useIam is true', async () => {
        vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIATEST');
        vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
        vi.stubEnv('AWS_REGION', 'eu-west-1');
        vi.stubEnv('AWS_SESSION_TOKEN', undefined);

        const client = createClient({ useIam: true });
        const upgradePromise = server.waitForNextUpgrade();
        await client.query(async () => 'done');
        const upgrade = await upgradePromise;

        expect(upgrade.headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
        expect(upgrade.headers['x-amz-date']).toBeDefined();
    });

    it('sends no Authorization header when useIam is false', async () => {
        const client = createClient();
        const upgradePromise = server.waitForNextUpgrade();
        await client.query(async () => 'done');
        const upgrade = await upgradePromise;

        expect(upgrade.headers.authorization).toBeUndefined();
        expect(upgrade.headers['x-amz-date']).toBeUndefined();
    });

    it('rejects when useIam is true but AWS env vars are missing', async () => {
        vi.stubEnv('AWS_ACCESS_KEY_ID', undefined);
        vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
        vi.stubEnv('AWS_REGION', undefined);
        vi.stubEnv('AWS_SESSION_TOKEN', undefined);

        const client = createClient({ useIam: true });
        await expect(client.query(async () => 'done')).rejects.toThrow(
            'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION are required'
        );
    });
});
