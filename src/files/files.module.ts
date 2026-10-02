import { Global, Module } from '@nestjs/common';
import { FilesDisk } from './files.disk';
import { FilesService } from './files.service';

@Global()
@Module({
    providers: [FilesDisk, FilesService],
    exports: [FilesService],
})
export class FilesModule {}
