#!/usr/bin/env node
/**
 * Creates (or repairs) a development account with the `tech_admin` role, so a
 * fresh deployment can be entered and a backup uploaded without touching the
 * database by hand.
 *
 *   npm run seed:admin
 *
 * Environment (read from backend/.env through `node --env-file`):
 *   MONGODB_URI            required, same connection string the backend uses
 *   SEED_ADMIN_NICK        default: dev-admin
 *   SEED_ADMIN_EMAIL       default: dev-admin@scribo.local
 *   SEED_ADMIN_PASSWORD    optional. Unset: a random password is generated and
 *                          printed once when the account is created. Set: the
 *                          password is (re)applied on every run.
 *   PASSWORD_SALT          bcrypt rounds, same meaning as in the backend
 *   SEED_ALLOW_PRODUCTION  must be "1" to run when NODE_ENV=production
 *
 * Idempotent: running it again never creates a second account.
 */
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
    await users.insertOne({
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

    console.log(`seed:admin: created tech_admin "${nick}" <${email}>`);
    if (!givenPassword) {
        console.log(`seed:admin: generated password (shown once): ${password}`);
    }
}

main()
    .catch((error) => fail(error instanceof Error ? error.message : String(error)))
    .finally(() => mongoose.disconnect().catch(() => undefined));
