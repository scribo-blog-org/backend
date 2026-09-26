import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Req,
    Res,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiConsumes,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { OptionalAuth, Public } from '../../authz/decorators/public.decorator';
import type { Actor } from '../../authz/policy';
import { RateLimits } from '../../common/rate-limit.guard';
import { imageFileInterceptor } from '../../common/upload';
import { AuthService } from './auth.service';
import { clearRefreshCookie, setRefreshCookie } from './auth.cookies';
import {
    AccessTokenDataDto,
    ForgotPasswordDto,
    LoginGoogleDto,
    LoginUsernameDto,
    RegisterEmailDto,
    RegisterGoogleDto,
    ResetPasswordDto,
    VerificationEmailConfirmDto,
    VerificationEmailDto,
    VerificationGoogleDto,
} from './dto/auth.dto';
import { PasswordResetService } from './password-reset.service';
import { RegisterService } from './register.service';
import { SessionService } from './session.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly sessions: SessionService,
        private readonly register: RegisterService,
        private readonly passwords: PasswordResetService,
    ) {}

    @Public()
    @Post('verification/google')
    @ApiOperation({
        summary:
            'Check Google token and whether the email is already registered',
    })
    async verificationGoogle(@Body() dto: VerificationGoogleDto) {
        const data = await this.auth.verifyGoogleToken(dto.googleToken);
        return { status: true, message: 'Google token is valid', data };
    }

    @Public()
    @Post('verification/email')
    async verificationEmail(@Body() dto: VerificationEmailDto) {
        await this.register.requestVerificationCode(dto.userEmail);
        return { status: true, message: 'Verification code sent', data: true };
    }

    @Public()
    @Post('verification/email/confirm')
    async verificationEmailConfirm(@Body() dto: VerificationEmailConfirmDto) {
        await this.register.confirmEmailCode(dto.userEmail, dto.emailCode);
        return { status: true, message: 'Email code is valid', data: true };
    }

    @Public()
    @Post('register/email')
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(imageFileInterceptor('userAvatar'))
    async registerEmail(
        @Body() body: RegisterEmailDto,
        @UploadedFile() avatar?: Express.Multer.File,
    ) {
        const data = await this.register.registerByEmail({
            userNickName: body.userNickName,
            userDescription: body.userDescription,
            userPassword: body.userPassword,
            avatar,
            userEmail: body.userEmail,
            emailCode: body.emailCode,
        });
        return { status: true, message: 'Register by email successful', data };
    }

    @Public()
    @Post('register/google')
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(imageFileInterceptor('userAvatar'))
    async registerGoogle(
        @Body() body: RegisterGoogleDto,
        @UploadedFile() avatar?: Express.Multer.File,
    ) {
        const data = await this.register.registerByGoogle({
            userNickName: body.userNickName,
            userDescription: body.userDescription,
            userPassword: body.userPassword,
            avatar,
            googleToken: body.googleToken,
        });
        return { status: true, message: 'Register by Google successful', data };
    }

    @Public()
    @RateLimits(
        { name: 'password-forgot-ip', windowMs: 15 * 60 * 1000, max: 8 },
        {
            name: 'password-forgot-email',
            windowMs: 15 * 60 * 1000,
            max: 3,
            by: 'email',
        },
    )
    @Post('password/forgot')
    async forgot(@Body() dto: ForgotPasswordDto) {
        await this.passwords.request(dto.userEmail);
        return {
            status: true,
            message: 'If the email exists, a code was sent',
            data: true,
        };
    }

    @Public()
    @RateLimits(
        { name: 'password-confirm-ip', windowMs: 15 * 60 * 1000, max: 20 },
        {
            name: 'password-confirm-email',
            windowMs: 15 * 60 * 1000,
            max: 8,
            by: 'email',
        },
    )
    @Post('password/forgot/confirm')
    async forgotConfirm(@Body() dto: VerificationEmailConfirmDto) {
        await this.passwords.confirm(dto.userEmail, dto.emailCode);
        return { status: true, message: 'Code is valid', data: true };
    }

    @Public()
    @RateLimits(
        { name: 'password-reset-ip', windowMs: 15 * 60 * 1000, max: 10 },
        {
            name: 'password-reset-email',
            windowMs: 15 * 60 * 1000,
            max: 5,
            by: 'email',
        },
    )
    @Post('password/reset')
    async resetPassword(@Body() dto: ResetPasswordDto) {
        await this.passwords.reset(dto);
        return { status: true, message: 'Password updated', data: true };
    }

    @Public()
    @Post('login/username')
    @ApiOperation({ summary: 'Login by email or nick name' })
    @ApiOkResponse({ type: AccessTokenDataDto })
    async loginUsername(
        @Body() dto: LoginUsernameDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        const tokens = await this.auth.loginByUsername(
            dto.userName,
            dto.userPassword,
            req,
        );
        setRefreshCookie(res, tokens.refreshToken, req);
        return {
            status: true,
            message: 'Login by username successful',
            data: {
                accessToken: tokens.accessToken,
            },
        };
    }

    @Public()
    @Post('login/google')
    @ApiOperation({ summary: 'Login with Google access token' })
    async loginGoogle(
        @Body() dto: LoginGoogleDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        const tokens = await this.auth.loginByGoogle(dto.googleToken, req);
        setRefreshCookie(res, tokens.refreshToken, req);
        return {
            status: true,
            message: 'Login by Google successful',
            data: {
                accessToken: tokens.accessToken,
            },
        };
    }

    @Public()
    @Post('refresh')
    async refresh(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        const tokens = await this.sessions.refreshSession(req);
        setRefreshCookie(res, tokens.refreshToken, req);

        return {
            status: true,
            message: 'Token refreshed',
            data: {
                accessToken: tokens.accessToken,
            },
        };
    }

    @OptionalAuth()
    @Post('logout')
    async logout(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @CurrentUser() actor?: Actor,
    ) {
        await this.sessions.logoutSession(req, actor);
        clearRefreshCookie(res, req);
        return { status: true, message: 'Logged out', data: null };
    }

    @ApiBearerAuth()
    @Get('sessions')
    async sessionsList(@CurrentUser() actor: Actor, @Req() req: Request) {
        const data = await this.sessions.listUserSessions(actor, req);
        return { status: true, message: 'Sessions fetched', data };
    }

    @ApiBearerAuth()
    @Delete('sessions/:id')
    async deleteSession(
        @Param('id') id: string,
        @CurrentUser() actor: Actor,
        @Req() req: Request,
    ) {
        const data = await this.sessions.revokeSession(actor, id, req);
        return { status: true, message: 'Session revoked', data };
    }
}
