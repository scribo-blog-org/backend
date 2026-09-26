import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { IsCategoryName } from '../../../validation/field-rules';

export class CreateCategoryDto {
    @ApiProperty()
    @IsString()
    @IsCategoryName()
    categoryName!: string;

    @ApiProperty()
    @IsNumber()
    categoryIcon!: number;

    @ApiProperty()
    @IsNumber()
    categoryColor!: number;
}

export class EditCategoryDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @IsCategoryName()
    categoryName?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    categoryIcon?: number;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    categoryColor?: number;
}
