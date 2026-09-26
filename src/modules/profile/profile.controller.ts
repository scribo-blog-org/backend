import {
    Body,
    Controller,
    Get,
    Patch,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import type { Actor } from '../../authz/policy';
import { imageFileInterceptor } from '../../infra/upload';
import { ChangePasswordDto, UpdateProfileDto } from './dto/profile.dto';
import { ProfileService } from './profile.service';

@ApiTags('profile')
@ApiBearerAuth()
@Controller('profile')
export class ProfileController {
    constructor(private readonly profile: ProfileService) {}

    @Get()
    async get(@CurrentUser() actor: Actor) {
        const data = await this.profile.get(actor);
        return { status: true, message: 'Profile fetched successfully', data };
    }

    @Patch()
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(imageFileInterceptor('userAvatar'))
    async edit(
        @CurrentUser() actor: Actor,
        @Body() dto: UpdateProfileDto,
        @UploadedFile() avatar?: Express.Multer.File,
    ) {
        const data = await this.profile.edit(actor, { ...dto }, avatar);
        return { status: true, message: 'Profile updated', data };
    }

    @Patch('password')
    async password(
        @CurrentUser() actor: Actor,
        @Body() dto: ChangePasswordDto,
    ) {
        await this.profile.changePassword(actor, dto);
        return { status: true, message: 'Password updated', data: true };
    }

    @Patch('notifications')
    async notifications(@CurrentUser() actor: Actor) {
        const data = await this.profile.readNotifications(actor);
        return { status: true, message: 'Notifications updated', data };
    }
}
