import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';

@Injectable()
export class MailService {
    private readonly transporter;

    constructor(private readonly config: ConfigService) {
        this.transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: this.config.get<string>('MAIL_SENDER'),
                pass: this.config.get<string>('MAIL_PASSWORD'),
            },
        });
    }

    async sendEmail({
        to,
        subject,
        html,
        code,
    }: {
        to: string;
        subject: string;
        html?: string;
        code?: string;
    }) {
        const htmlContent = html || `<p>Your code: <b>${code}</b></p>`;
        try {
            return await this.transporter.sendMail({
                from: '"Scribo Blog" <scribo.blog.dev@gmail.com>',
                to,
                subject,
                html: htmlContent,
            });
        } catch {
            throw new InternalServerErrorException('Failed to send email!');
        }
    }
}
