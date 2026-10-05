import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import {
    IsDescription,
    IsEmailCode,
    IsLoginName,
    IsNickName,
    IsPassword,
    IsUserEmail,
} from '../../../validation/field-rules';

export class LoginUsernameDto {
    @ApiProperty({ example: 'Dev' })
    @IsString()
    @IsLoginName()
    userName!: string;

    @ApiProperty()
    @IsString()
    @IsPassword()
    userPassword!: string;
}

export class LoginGoogleDto {
    @ApiProperty()
    @IsString()
    googleToken!: string;
}

export class AccessTokenDataDto {
    @ApiProperty()
    accessToken!: string;
}

export class VerificationGoogleDto {
    @ApiProperty()
    @IsString()
    googleToken!: string;
}

export class GoogleVerificationDataDto {
    @ApiProperty()
    email!: string;

    @ApiProperty()
    is_registered!: boolean;
}

export class UpdateRoleDto {
    @ApiProperty({ example: 'author' })
    @IsString()
    userRole!: string;
}

export class UpdateVerifiedDto {
    @ApiProperty()
    @IsBoolean()
    verified!: boolean;
}

export class VerificationEmailDto {
    @ApiProperty()
    @IsUserEmail()
    userEmail!: string;
}

export class VerificationEmailConfirmDto {
    @ApiProperty()
    @IsUserEmail()
    userEmail!: string;

    @ApiProperty()
    @IsString()
    @IsEmailCode()
    emailCode!: string;
}

export class ForgotPasswordDto {
    @ApiProperty()
    @IsUserEmail()
    userEmail!: string;
}

export class ResetPasswordDto {
    @ApiProperty()
    @IsUserEmail()
    userEmail!: string;

    @ApiProperty()
    @IsString()
    @IsEmailCode()
    emailCode!: string;

    @ApiProperty()
    @IsString()
    @IsPassword()
    newPassword!: string;

    @ApiProperty()
    @IsString()
    @IsPassword()
    newPasswordConfirm!: string;
}

export class RegisterEmailDto {
    @ApiProperty()
    @IsString()
    @IsNickName()
    userNickName!: string;

    @ApiProperty()
    @IsString()
    @IsPassword()
    userPassword!: string;

    @ApiProperty()
    @IsUserEmail()
    userEmail!: string;

    @ApiProperty()
    @IsString()
    @IsEmailCode()
    emailCode!: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @IsDescription()
    userDescription?: string;
}

export class RegisterGoogleDto {
    @ApiProperty()
    @IsString()
    @IsNickName()
    userNickName!: string;

    @ApiProperty()
    @IsString()
    @IsPassword()
    userPassword!: string;

    @ApiProperty()
    @IsString()
    googleToken!: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @IsDescription()
    userDescription?: string;
}
