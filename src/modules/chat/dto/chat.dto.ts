import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsMongoId,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { FIELD_LIMITS } from '../../../validation/field-limits';

export class CreateConversationDto {
    @ApiProperty()
    @IsMongoId()
    userId!: string;
}

export class SendMessageDto {
    @ApiProperty()
    @IsString()
    @MinLength(FIELD_LIMITS.chatMessage.min)
    @MaxLength(FIELD_LIMITS.chatMessage.max)
    text!: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsMongoId()
    replyTo?: string;
}

export class EditMessageDto {
    @ApiProperty()
    @IsString()
    @MinLength(FIELD_LIMITS.chatMessage.min)
    @MaxLength(FIELD_LIMITS.chatMessage.max)
    text!: string;
}

export class ListMessagesQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    before?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    limit?: string;
}
