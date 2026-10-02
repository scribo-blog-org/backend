import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
    StreamableFile,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';

@Injectable()
export class ApiEnvelopeInterceptor implements NestInterceptor {
    intercept(
        _context: ExecutionContext,
        next: CallHandler,
    ): Observable<unknown> {
        return next.handle().pipe(
            map((payload: unknown) => {
                if (payload instanceof StreamableFile) {
                    return payload;
                }

                if (
                    payload &&
                    typeof payload === 'object' &&
                    'status' in payload &&
                    'message' in payload &&
                    'data' in payload
                ) {
                    return payload;
                }

                return {
                    status: true,
                    message: 'OK',
                    data: payload ?? null,
                };
            }),
        );
    }
}
