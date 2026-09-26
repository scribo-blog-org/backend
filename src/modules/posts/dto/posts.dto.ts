import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import {
    IsCommentText,
    IsPostContent,
    IsPostTitle,
} from '../../../validation/field-rules';

export class CreatePostDto {
    @ApiProperty()
    @IsString()
    @IsPostTitle()
    postTitle!: string;

    @ApiProperty()
    @IsString()
    @IsPostContent()
    postContent!: string;

    @ApiProperty()
    @IsString()
    categoryId!: string;
}

export class EditPostDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @IsPostTitle()
    postTitle?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @IsPostContent()
    postContent?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    categoryId?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    featuredImage?: unknown;
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
