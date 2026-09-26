import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import {
    IsSupportMessage,
    IsSupportReply,
    IsUserEmail,
} from '../../../validation/field-rules';

export class CreateSupportDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @Transform(({ value }) => (value === '' ? undefined : value))
    @IsUserEmail()
    userEmail?: string;

    @ApiProperty()
    @IsString()
    @IsIn(['complaint', 'request', 'help'])
    supportKind!: string;

    @ApiProperty()
    @IsString()
    @IsSupportMessage()
    supportMessage!: string;
}

export class SupportReplyDto {
    @ApiProperty()
    @IsString()
    @IsSupportReply()
    replyText!: string;
}

export class SupportStatusDto {
    @ApiProperty()
    @IsString()
    supportStatus!: string;
}
