import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { FilesService } from '../files/files.service';
import { rlog } from './rlog';

@Injectable()
export class StartupService {
    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly files: FilesService,
    ) {}

    async assertDatabase() {
        if (this.connection.readyState !== 1 || !this.connection.db) {
            throw new Error(
                `Database connection failed (readyState=${this.connection.readyState})`,
            );
        }

        await this.connection.db.command({ ping: 1 });
        rlog.info('mongo connected', {
            host: this.connection.host,
            db: this.connection.name,
        });
        this.connection.on('disconnected', () =>
            rlog.error('mongo disconnected'),
        );
        this.connection.on('reconnected', () => rlog.info('mongo reconnected'));
        this.connection.on('error', (error: Error) =>
            rlog.error('mongo error', { error }),
        );
    }

    async assertFiles() {
        const { dir, publicUrl } = await this.files.assertReady();
        rlog.info('files ready', { dir, url: publicUrl });
    }
}
