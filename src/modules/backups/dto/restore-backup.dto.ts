import { ApiProperty } from '@nestjs/swagger';
import { Equals } from 'class-validator';

export class RestoreBackupDto {
    @ApiProperty({
        description: 'Must be true: restoring replaces the database and files',
    })
    @Equals(true, { message: 'Restore must be confirmed' })
    confirm!: boolean;
}
