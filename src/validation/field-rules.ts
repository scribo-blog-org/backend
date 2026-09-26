import { applyDecorators } from '@nestjs/common';
import { IsEmail, Matches, MaxLength, MinLength } from 'class-validator';
import { FIELD_LIMITS } from './field-limits';

export function IsPassword() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.password.min, {
            message: `Password must be at least ${FIELD_LIMITS.password.min} characters long!`,
        }),
        MaxLength(FIELD_LIMITS.password.max, {
            message: `Password cannot be longer than ${FIELD_LIMITS.password.max} characters!`,
        }),
    );
}

export function IsNickName() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.nick.min, {
            message: `Nick name must be at least ${FIELD_LIMITS.nick.min} characters long!`,
        }),
        MaxLength(FIELD_LIMITS.nick.max, {
            message: `Nick name cannot be longer than ${FIELD_LIMITS.nick.max} characters!`,
        }),
    );
}

export function IsLoginName() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.login.min, {
            message: `Login must be at least ${FIELD_LIMITS.login.min} characters long!`,
        }),
        MaxLength(FIELD_LIMITS.login.max, {
            message: `Login cannot be longer than ${FIELD_LIMITS.login.max} characters!`,
        }),
    );
}

export function IsUserEmail() {
    return applyDecorators(
        IsEmail({}, { message: 'Incorrect email!' }),
        MaxLength(FIELD_LIMITS.email.max, {
            message: `Email cannot be longer than ${FIELD_LIMITS.email.max} characters!`,
        }),
        MinLength(FIELD_LIMITS.email.min, {
            message: `Email must be at least ${FIELD_LIMITS.email.min} characters long!`,
        }),
    );
}

export function IsDescription() {
    return MaxLength(FIELD_LIMITS.description.max, {
        message: `Description cannot be longer than ${FIELD_LIMITS.description.max} characters!`,
    });
}

export function IsPostTitle() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.postTitle.min, {
            message: 'Title is required!',
        }),
        MaxLength(FIELD_LIMITS.postTitle.max, {
            message: `Title cannot be longer than ${FIELD_LIMITS.postTitle.max} characters!`,
        }),
    );
}

export function IsPostContent() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.postContent.min, {
            message: 'Content is required!',
        }),
        MaxLength(FIELD_LIMITS.postContent.max, {
            message: `Content cannot be longer than ${FIELD_LIMITS.postContent.max} characters!`,
        }),
    );
}

export function IsCommentText() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.comment.min, {
            message: 'Comment is required!',
        }),
        MaxLength(FIELD_LIMITS.comment.max, {
            message: `Comment cannot be longer than ${FIELD_LIMITS.comment.max} characters!`,
        }),
    );
}

export function IsCategoryName() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.categoryName.min, {
            message: 'Category name is required!',
        }),
        MaxLength(FIELD_LIMITS.categoryName.max, {
            message: `Category name cannot be longer than ${FIELD_LIMITS.categoryName.max} characters!`,
        }),
    );
}

export function IsSupportMessage() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.supportMessage.min, {
            message: `Message must be at least ${FIELD_LIMITS.supportMessage.min} characters long!`,
        }),
        MaxLength(FIELD_LIMITS.supportMessage.max, {
            message: `Message cannot be longer than ${FIELD_LIMITS.supportMessage.max} characters!`,
        }),
    );
}

export function IsSupportReply() {
    return applyDecorators(
        MinLength(FIELD_LIMITS.supportReply.min, {
            message: 'Reply is required!',
        }),
        MaxLength(FIELD_LIMITS.supportReply.max, {
            message: `Reply cannot be longer than ${FIELD_LIMITS.supportReply.max} characters!`,
        }),
    );
}

export function IsEmailCode() {
    return Matches(/^[0-9]{6}$/, { message: 'Incorrect email code!' });
}
