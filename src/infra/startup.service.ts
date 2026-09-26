import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { StorageService } from './storage.service';

@Injectable()
export class StartupService {
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
        console.log(
            `backend mongo connected host=${this.connection.host} db=${this.connection.name}`,
        );
    }

    async assertAws() {
        const { bucket, region } = await this.storage.assertReady();
        console.log(`backend aws connected bucket=${bucket} region=${region}`);
    }
}
