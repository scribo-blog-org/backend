// Removes log entries that can no longer say anything: the post, category or
// user they are about is gone and the log has no name snapshot, so the admin
// panel can only render them as nameless "deleted" cards.
//
// Dry run (default):
//   mongosh "<uri>" --quiet scripts/clean-stale-logs.mongosh.js
// Apply:
//   mongosh "<uri>" --quiet --eval 'var APPLY = true' scripts/clean-stale-logs.mongosh.js
//
// Dump the collection first:
//   mongodump --uri="<uri>" --collection=logs --archive --gzip > logs.archive.gz

const apply = typeof APPLY !== 'undefined' && APPLY === true;
const ids = (name) =>
    new Set(
        db
            .getCollection(name)
            .find({}, { _id: 1 })
            .toArray()
            .map((item) => String(item._id)),
    );
const posts = ids('posts');
const categories = ids('categories');
const users = ids('users');
const empty = (value) => value === null || value === undefined || value === '';

const stale = [];
const byReason = {};
db.logs.find({}).forEach((log) => {
    const data = log.data || {};
    const reasons = [];
    if (log.type === 'edit_post') reasons.push('legacy type edit_post');
    if (data.post && !posts.has(String(data.post)) && empty(data.post_title))
        reasons.push('post gone, no title snapshot');
    if (
        data.category &&
        !categories.has(String(data.category)) &&
        empty(data.category_snapshot && data.category_snapshot.name)
    )
        reasons.push('category gone, no snapshot');
    if (data.user && !users.has(String(data.user)) && empty(data.user_nick))
        reasons.push('user gone, no nick snapshot');
    if (
        data.target_user &&
        !users.has(String(data.target_user)) &&
        empty(data.target_nick)
    )
        reasons.push('target user gone, no nick snapshot');
    if (reasons.length) {
        stale.push(log._id);
        const key = `${log.type}: ${reasons[0]}`;
        byReason[key] = (byReason[key] || 0) + 1;
    }
});

print(`logs: ${db.logs.countDocuments({})}, stale: ${stale.length}`);
Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .forEach(([key, count]) => print(`${String(count).padStart(5)}  ${key}`));

if (apply) {
    const result = db.logs.deleteMany({ _id: { $in: stale } });
    print(`deleted ${result.deletedCount}, left ${db.logs.countDocuments({})}`);
} else {
    print('dry run, nothing deleted (set APPLY = true to delete)');
}
