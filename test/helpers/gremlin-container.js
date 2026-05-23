import { GenericContainer, Wait } from 'testcontainers';

export async function startGremlinServer() {
    const container = await new GenericContainer('tinkerpop/gremlin-server:3.7.3')
        .withExposedPorts(8182)
        .withWaitStrategy(Wait.forLogMessage(/Channel started at port 8182/))
        .start();

    return {
        host: container.getHost(),
        port: container.getMappedPort(8182),
        stop: () => container.stop()
    };
}
