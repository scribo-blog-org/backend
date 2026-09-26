import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OptionalAuth } from '../../authz/decorators/public.decorator';
import { LinkPreviewService } from './link-preview.service';

@ApiTags('link-preview')
@Controller('link-preview')
export class LinkPreviewController {
    constructor(private readonly previews: LinkPreviewService) {}

    @OptionalAuth()
    @Get()
    @ApiOperation({
        summary: 'Fetch Open Graph preview for a URL (no storage)',
    })
    async preview(@Query('url') url: string) {
        const data = await this.previews.fetchPreview(url);
        return { status: true, message: 'Preview fetched', data };
    }
}
