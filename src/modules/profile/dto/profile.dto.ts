import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
    IsNickName,
    IsPassword,
    IsDescription,
} from '../../../validation/field-rules';

const toBoolean = ({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
};

export class UpdateProfileDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @IsNickName()
    userNickName?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @IsDescription()
    userDescription?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @Transform(toBoolean)
    @IsBoolean()
    isEmailPublic?: boolean;

    @ApiPropertyOptional()
    @IsOptional()
    @Transform(toBoolean)
    @IsBoolean()
    isSavedPostsPublic?: boolean;

    @ApiPropertyOptional()
    @IsOptional()
    @Transform(toBoolean)
    @IsBoolean()
    isLastActivityPublic?: boolean;

    @ApiPropertyOptional()
    @IsOptional()
    userAvatar?: unknown;
}

export class ChangePasswordDto {
    @ApiProperty()
    @IsString()
    @IsPassword()
    currentPassword!: string;

    @ApiProperty()
    @IsString()
    @IsPassword()
    newPassword!: string;

    @ApiProperty()
    @IsString()
    @IsPassword()
    newPasswordConfirm!: string;
}
