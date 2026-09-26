import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import type { Actor } from '../../authz/policy';
import { ParseMongoIdPipe } from '../../http/mongo-id';
import { CommentsService } from './comments.service';
import { EditCommentDto } from './dto/comments.dto';

@ApiTags('comments')
@Controller('comments')
export class CommentsController {
    constructor(private readonly comments: CommentsService) {}

    @ApiBearerAuth()
    @Delete(':id')
    async remove(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.comments.remove(id, actor);
        return { status: true, message: 'Comment deleted successfully!', data };
    }

    @ApiBearerAuth()
    @Patch(':id')
    async edit(
        @Param('id', ParseMongoIdPipe) id: string,
        @Body() dto: EditCommentDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.comments.edit(id, dto.commentText, actor);
        return { status: true, message: 'Comment edited successfully!', data };
    }

    @ApiBearerAuth()
    @Post(':id/like')
    async like(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.comments.like(id, actor);
        return { status: true, message: 'Comment liked successfully', data };
    }

    @ApiBearerAuth()
    @Delete(':id/like')
    async unlike(
        @Param('id', ParseMongoIdPipe) id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.comments.unlike(id, actor);
        return { status: true, message: 'Comment unliked successfully', data };
    }
}
