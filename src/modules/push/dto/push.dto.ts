import { Type } from 'class-transformer';
import {
    IsNotEmptyObject,
    IsString,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class PushKeysDto {
    @ApiProperty()
    @IsString()
    @MaxLength(256)
    p256dh!: string;

    @ApiProperty()
    @IsString()
    @MaxLength(256)
    auth!: string;
}

export class PushSubscribeDto {
    @ApiProperty()
    @IsString()
    @MaxLength(2048)
    endpoint!: string;

    @ApiProperty({ type: PushKeysDto })
    @IsNotEmptyObject()
    @ValidateNested()
    @Type(() => PushKeysDto)
    keys!: PushKeysDto;
}

export class PushUnsubscribeDto {
    @ApiProperty()
    @IsString()
    @MaxLength(2048)
    endpoint!: string;
}
