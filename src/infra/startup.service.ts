import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { FilesService } from '../files/files.service';

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
        console.log(
            `backend mongo connected host=${this.connection.host} db=${this.connection.name}`,
        );
    }

    async assertFiles() {
        const { dir, publicUrl } = await this.files.assertReady();
        console.log(`backend files ready dir=${dir} url=${publicUrl}`);
    }
}
