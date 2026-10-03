import {
    CanActivate,
    ExecutionContext,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { BackupsService } from './backups.service';

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class MaintenanceGuard implements CanActivate {
    constructor(private readonly backups: BackupsService) {}

    canActivate(context: ExecutionContext) {
        if (!this.backups.isRestoring()) return true;
        const request = context.switchToHttp().getRequest<Request>();
        if (READ_ONLY.has(request.method)) return true;
        if (request.originalUrl.startsWith('/api/backups')) return true;
        throw new ServiceUnavailableException(
            'The site is being restored from a backup, try again in a minute',
        );
    }
}
