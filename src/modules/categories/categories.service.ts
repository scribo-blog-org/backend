import {
    ConflictException,
    ForbiddenException,
    HttpStatus,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, type Actor } from '../../authz/policy';
import { fieldError } from '../../http/http-errors';
import { LoggerService } from '../../infra/logger.service';
import { categorySnapshot, changeOf, compact } from '../../infra/log-helpers';
import { Category } from '../../database/schemas/category.schema';
import { Post } from '../../database/schemas/post.schema';

@Injectable()
export class CategoriesService {
    constructor(
        @InjectModel(Category.name)
        private readonly categories: Model<Category>,
        @InjectModel(Post.name) private readonly posts: Model<Post>,
        private readonly logger: LoggerService,
    ) {}

    async list() {
        const categories = await this.categories.find().lean();
        const posts = await this.posts.find().select('category').lean();
        const counts: Record<string, number> = {};
        for (const post of posts) {
            const id = String(post.category);
            counts[id] = (counts[id] || 0) + 1;
        }
        return categories.map((category) => ({
            ...category,
            posts_count: counts[String(category._id)] || 0,
        }));
    }

    async create(
        data: {
            categoryName: string;
            categoryIcon: number;
            categoryColor: number;
        },
        actor: Actor,
    ) {
        if (!hasPermission(actor, PERMISSIONS.CREATE_CATEGORY)) {
            throw new ForbiddenException(
                "You don't have permission to create a category",
            );
        }
        if (await this.categories.findOne({ name: data.categoryName }).lean()) {
            throw fieldError(
                'categoryName',
                'Category name already exists!',
                data.categoryName,
                HttpStatus.CONFLICT,
            );
        }
        const result = await this.categories.create({
            name: data.categoryName,
            icon: data.categoryIcon,
            color: data.categoryColor,
        });
        await this.logger.action(
            'create_category',
            actor,
            {
                category: result._id,
                category_snapshot: categorySnapshot(result),
            },
            `User ${actor.nick_name} created category`,
        );
        return result;
    }

    async edit(
        id: string,
        data: {
            categoryName?: string;
            categoryIcon?: number;
            categoryColor?: number;
        },
        actor: Actor,
    ) {
        if (!hasPermission(actor, PERMISSIONS.EDIT_ANY_CATEGORY)) {
            throw new ForbiddenException(
                "You don't have permission to edit a category",
            );
        }
        const category = await this.categories.findById(id).lean();
        if (!category) {
            throw new NotFoundException('Category not found!');
        }
        if (data.categoryName) {
            const existing = await this.categories
                .findOne({ name: data.categoryName })
                .lean();
            if (existing && String(existing._id) !== id) {
                throw fieldError(
                    'categoryName',
                    'Category name already exists!',
                    data.categoryName,
                    HttpStatus.CONFLICT,
                );
            }
        }
        const update: Record<string, unknown> = {};
        if (data.categoryName !== undefined) update.name = data.categoryName;
        if (data.categoryIcon !== undefined) update.icon = data.categoryIcon;
        if (data.categoryColor !== undefined) update.color = data.categoryColor;
        const result = await this.categories
            .findByIdAndUpdate(id, update, { returnDocument: 'after' })
            .lean();
        if (!result) {
            throw new NotFoundException('Category not found!');
        }
        const posts = await this.posts.countDocuments({
            category: new Types.ObjectId(id),
        });
        const changes = compact([
            changeOf('name', category.name, result.name),
            changeOf('icon', category.icon, result.icon),
            changeOf('color', category.color, result.color),
        ]);
        if (changes.length) {
            await this.logger.action(
                'update_category',
                actor,
                {
                    category: result._id,
                    category_snapshot: categorySnapshot(result),
                    changes,
                },
                `User ${actor.nick_name} updated category`,
            );
        }
        return { ...result, posts_count: posts };
    }

    async remove(id: string, actor: Actor) {
        if (!hasPermission(actor, PERMISSIONS.DELETE_ANY_CATEGORY)) {
            throw new ForbiddenException(
                "You don't have permission to delete a category",
            );
        }
        const category = await this.categories.findById(id).lean();
        if (!category) {
            throw new NotFoundException('Category not found!');
        }
        const posts = await this.posts.countDocuments({
            category: new Types.ObjectId(id),
        });
        if (posts > 0) {
            throw new ConflictException(
                'Cannot delete category with associated posts!',
            );
        }
        await this.categories.findByIdAndDelete(id);
        await this.logger.action(
            'delete_category',
            actor,
            { category: id, category_snapshot: categorySnapshot(category) },
            `User ${actor.nick_name} deleted category`,
        );
        return category;
    }
}
