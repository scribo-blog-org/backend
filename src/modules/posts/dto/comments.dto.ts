import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IsCommentText } from '../../../validation/field-rules';

export class EditCommentDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @IsCommentText()
    commentText?: string;
}
