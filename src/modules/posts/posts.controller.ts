import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { OptionalAuth, Public } from '../../authz/decorators/public.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import { RateLimits } from '../../http/rate-limit.guard';
import { clientIp } from '../../visitor/geo';
import { ParseMongoIdPipe } from '../../http/mongo-id';
import { ListPostsQueryDto } from '../../http/query.dto';
import { imageFileInterceptor } from '../../files/upload';
import { CommentsService } from './comments.service';
import { CreateCommentDto, CreatePostDto, EditPostDto } from './dto/posts.dto';
import { PostsService } from './posts.service';

@ApiTags('posts')
@Controller('posts')
export class PostsController {
    constructor(
        private readonly posts: PostsService,
        private readonly comments: CommentsService,
    ) {}

    @Public()
    @Get()
    async list(@Query() query: ListPostsQueryDto) {
        const data = await this.posts.list(query);
        return { status: true, message: 'Posts fetched successfully!', data };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CREATE_POST)
    @RateLimits({
        name: 'post-create',
        windowMs: 60_000,
        max: 2,
        by: 'user',
    })
    @Post()
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(imageFileInterceptor('featuredImage'))
    async create(
        @Body() dto: CreatePostDto,
        @UploadedFile() featuredImage: Express.Multer.File | undefined,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.posts.create(dto, featuredImage, actor);
        return { status: true, message: 'Post created successfully!', data };
    }

    @Public()
    @Get(':id/comments')
    async listComments(
        @Param('id', ParseMongoIdPipe) id: string,
        @Query('expand') expand?: string,
    ) {
        const data = await this.comments.listForPost(id, expand);
        return {
            status: true,
            message: 'Comments fetched successfully!',
            data,
        };
    }

    @ApiBearerAuth()
    @Post(':id/comments')
    async createComment(
        @Param('id', ParseMongoIdPipe) id: string,
        @Body() dto: CreateCommentDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.comments.create(
            id,
            dto.commentText,
            dto.parentCommentId,
            actor,
        );
        return { status: true, message: 'Comment added successfully!', data };
    }

    @ApiBearerAuth()
    @Post(':id/save')
    async save(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.posts.save(id, actor);
        return { status: true, message: 'Post saved successfully!', data };
    }

    @ApiBearerAuth()
    @Delete(':id/save')
    async unsave(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.posts.unsave(id, actor);
        return { status: true, message: 'Post unsaved successfully!', data };
    }

    @ApiBearerAuth()
    @Post(':id/like')
    async like(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.posts.like(id, actor);
        return { status: true, message: 'Post liked successfully!', data };
    }

    @ApiBearerAuth()
    @Delete(':id/like')
    async unlike(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.posts.unlike(id, actor);
        return { status: true, message: 'Post unliked successfully!', data };
    }

    @OptionalAuth()
    @Get(':id')
    async get(
        @Req() req: Request,
        @Param('id', ParseMongoIdPipe) id: string,
        @Query('expand') expand?: string,
        @Query('view') view?: string,
        @CurrentUser() actor?: Actor,
    ) {
        const countView = view === '1' || view === 'true';
        const data = await this.posts.getById(id, expand, {
            count: countView,
            viewerKey: actor?.id || clientIp(req) || 'anon',
        });
        return { status: true, message: 'Post fetched successfully!', data };
    }

    @ApiBearerAuth()
    @Patch(':id')
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(imageFileInterceptor('featuredImage'))
    async edit(
        @Param('id', ParseMongoIdPipe) id: string,
        @Body() dto: EditPostDto,
        @UploadedFile() featuredImage: Express.Multer.File | undefined,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.posts.edit(id, dto, featuredImage, actor);
        return { status: true, message: 'Post updated successfully', data };
    }

    @ApiBearerAuth()
    @Delete(':id')
    async remove(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.posts.remove(id, actor);
        return { status: true, message: 'Post deleted successfully!', data };
    }
}
