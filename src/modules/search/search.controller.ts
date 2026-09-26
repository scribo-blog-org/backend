import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../authz/decorators/public.decorator';
import { RateLimits } from '../../http/rate-limit.guard';
import { clientIp } from '../../visitor/geo';
import { SearchQueryDto } from './dto/search.dto';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
    constructor(private readonly search: SearchService) {}

    @Public()
    @Get('hashtags')
    @RateLimits({ name: 'search-hashtags', windowMs: 60_000, max: 60 })
    @ApiOperation({ summary: 'Suggest existing hashtags' })
    async hashtags(@Query() dto: SearchQueryDto) {
        const data = await this.search.suggestHashtags(dto.q);
        return { status: true, message: 'Hashtag suggestions', data };
    }

    @Public()
    @Get()
    @RateLimits({ name: 'search', windowMs: 60_000, max: 40 })
    @ApiOperation({
        summary: 'Search posts, users, and categories',
    })
    async query(@Query() dto: SearchQueryDto, @Req() req: Request) {
        const data = await this.search.search(dto.q, { ip: clientIp(req) });
        return { status: true, message: 'Search results', data };
    }
}
