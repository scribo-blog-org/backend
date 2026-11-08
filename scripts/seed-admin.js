#!/usr/bin/env node
const { randomBytes } = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

function fail(message) {
    console.error(`seed:admin: ${message}`);
    process.exit(1);
}

function rounds() {
    const value = Number.parseInt(process.env.PASSWORD_SALT || '', 10);
    return Number.isFinite(value) && value >= 4 && value <= 31 ? value : 10;
}

async function writeLog(entry) {
    try {
        await mongoose.connection.collection('logs').insertOne({
            date_time: new Date(),
            level: 'info',
            ...entry,
        });
    } catch (error) {
        console.error(
            `seed:admin: could not write the log entry: ${error instanceof Error ? error.message : error}`,
        );
    }
}

async function main() {
    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) fail('MONGODB_URI is not set (run through `npm run seed:admin`)');

    if (
        process.env.NODE_ENV === 'production' &&
        process.env.SEED_ALLOW_PRODUCTION !== '1'
    ) {
        fail('refusing to run with NODE_ENV=production (SEED_ALLOW_PRODUCTION=1 overrides)');
    }

    const nick = (process.env.SEED_ADMIN_NICK || 'dev-admin').trim();
    const email = (process.env.SEED_ADMIN_EMAIL || 'dev-admin@scribo.local')
        .trim()
        .toLowerCase();
    const givenPassword = process.env.SEED_ADMIN_PASSWORD;

    if (nick.length < 3 || nick.length > 24) fail('nick must be 3-24 characters');
    if (givenPassword !== undefined && givenPassword !== '' &&
        (givenPassword.length < 8 || givenPassword.length > 64)) {
        fail('SEED_ADMIN_PASSWORD must be 8-64 characters');
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    const users = mongoose.connection.collection('users');

    const existing = await users.findOne({ nick_name: nick });
    const now = new Date();

    if (existing) {
        const set = { role: 'tech_admin', is_verified: true };
        if (givenPassword) set.password = bcrypt.hashSync(givenPassword, rounds());
        await users.updateOne({ _id: existing._id }, { $set: set });
        await writeLog({
            type: 'seed_admin',
            message: `Seed restored administrator ${nick}`,
            data: {
                system: true,
                created: false,
                updated_user: existing._id,
                target_nick: nick,
                old_role: existing.role,
                new_role: 'tech_admin',
                password_changed: Boolean(givenPassword),
            },
        });
        console.log(
            `seed:admin: user "${nick}" already existed, role set to tech_admin` +
                (givenPassword ? ', password updated' : ', password unchanged'),
        );
        return;
    }

    if (await users.findOne({ email })) {
        fail(`email ${email} is already used by another account; set SEED_ADMIN_EMAIL`);
    }

    const password = givenPassword || randomBytes(12).toString('base64url');
    const inserted = await users.insertOne({
        nick_name: nick,
        email,
        password: bcrypt.hashSync(password, rounds()),
        role: 'tech_admin',
        is_admin: false,
        is_verified: true,
        is_email_public: false,
        is_saved_posts_public: true,
        is_last_activity_public: true,
        created_date: now,
        last_activity_at: now,
        saved_posts: [],
        follows: [],
        followers: [],
        notifications: [],
    });

    await writeLog({
        type: 'seed_admin',
        message: `Seed created administrator ${nick}`,
        data: {
            system: true,
            created: true,
            updated_user: inserted.insertedId,
            target_nick: nick,
            new_role: 'tech_admin',
            password_generated: !givenPassword,
        },
    });

    console.log(`seed:admin: created tech_admin "${nick}" <${email}>`);
    if (!givenPassword) {
        console.log(`seed:admin: generated password (shown once): ${password}`);
    }
}

main()
    .catch((error) => fail(error instanceof Error ? error.message : String(error)))
    .finally(() => mongoose.disconnect().catch(() => undefined));
