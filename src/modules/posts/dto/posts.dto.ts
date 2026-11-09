import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IsCommentText, IsPostContent } from '../../../validation/field-rules';

const MEDIA_DOC =
    "Media: JSON array (max 10) sent as a JSON string in multipart/form-data. Items: { upload: '<clientId>', width?, height? } for a new file (the file goes in the same request as a file part named <clientId>; image/jpeg|png|webp|avif|gif or video/mp4|webm|quicktime, <= 100 MB each), { id, type, url } for a file that is already on the post (edit), { type: 'embed', url } for any http(s) link. Total uploaded size per post <= 100 MB. [] removes all media.";

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
