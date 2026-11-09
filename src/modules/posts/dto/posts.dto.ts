import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IsCommentText, IsPostContent } from '../../../validation/field-rules';

const MEDIA_DOC =
    "Media: JSON array (max 10) of { type: 'image'|'gif'|'video', url (from POST /posts/media), poster?, width?, height? } or { type: 'embed', url (any http(s) link) }. Send as JSON or as a JSON string in multipart. Total uploaded size per post <= 100 MB. [] removes all media.";

export class CreatePostDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @IsPostContent()
    postContent?: string;

    @ApiProperty({ required: false, description: MEDIA_DOC })
    @IsOptional()
    media?: unknown;
}

export class EditPostDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @IsPostContent()
    postContent?: string;

    @ApiProperty({ required: false, description: MEDIA_DOC })
    @IsOptional()
    media?: unknown;
}

export class CreateCommentDto {
    @ApiProperty()
    @IsString()
    @IsCommentText()
    commentText!: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    parentCommentId?: string;
}
