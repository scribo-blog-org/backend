import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { existsSync } from 'fs';
import { RuntimeLog, runtimeLogOptionsFromEnv } from './runtime-log';

if (
    !process.env.JEST_WORKER_ID &&
    process.env.LOG_DIR === undefined &&
    existsSync('.env')
) {
    process.loadEnvFile('.env');
}

export const rlog = new RuntimeLog(runtimeLogOptionsFromEnv('backend'));

const text = (message: unknown) =>
    typeof message === 'string'
        ? message
        : message instanceof Error
          ? message.message
          : JSON.stringify(message);

export class NestRuntimeLogger extends ConsoleLogger {
    constructor() {
        super();
        this.setLogLevels(['error', 'warn'] as LogLevel[]);
    }

    error(message: unknown, ...rest: unknown[]) {
        const stack = rest.find(
            (item): item is string =>
                typeof item === 'string' && item.includes('\n    at '),
        );
        const context = rest.find(
            (item): item is string =>
                typeof item === 'string' && item !== stack,
        );
        rlog.error(text(message), { context, stack });
    }

    warn(message: unknown, ...rest: unknown[]) {
        const context = rest.find(
            (item): item is string => typeof item === 'string',
        );
        rlog.warn(text(message), { context });
    }
}

export function installProcessHandlers() {
    process.on('unhandledRejection', (reason) => {
        rlog.error('unhandledRejection', { error: reason });
    });
    process.on('uncaughtException', (error) => {
        rlog.error('uncaughtException', { error });
        setTimeout(() => process.exit(1), 100).unref();
    });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
            rlog.info('shutdown', { signal });
        });
    }
}
