import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { StorageService } from './storage.service';

@Injectable()
export class StartupService {
    private readonly logger = new Logger('Startup');

    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly storage: StorageService,
    ) {}

    async assertDatabase() {
        if (this.connection.readyState !== 1 || !this.connection.db) {
            throw new Error(
                `Database connection failed (readyState=${this.connection.readyState})`,
            );
        }

        await this.connection.db.command({ ping: 1 });
        this.logger.log(
            `database ok host=${this.connection.host} db=${this.connection.name}`,
        );
    }

    async assertAws() {
        const { bucket, region } = await this.storage.assertReady();
        this.logger.log(`aws ok bucket=${bucket} region=${region}`);
    }
}
