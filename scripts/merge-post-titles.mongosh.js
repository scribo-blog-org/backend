// Merges legacy post titles into the post body and converts featured_image to media[].
//
// Dry run by default. Run with:
//   mongosh "$MONGODB_URI" --eval "APPLY = true" scripts/merge-post-titles.mongosh.js
// Idempotent: posts that no longer have `title` / `featured_image` are not touched.
//
// For every post that still has `title`:
//   content_text = '<p><strong>' + escape(title) + '</strong></p>' + content_text
//   (plain-text content without tags is wrapped in <p>; empty titles are only unset)
//   $unset title
// For every post with a representable featured_image (a stored '/uploads/...' path):
//   media = [{ id, type: 'image'|'gif', url: featured_image }]  (only if media is empty)
//   $unset featured_image
// Other featured_image values are left alone and counted as skipped.

const apply = typeof APPLY !== 'undefined' && APPLY === true;

const escapeHtml = (value) =>
    String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const hasTags = (value) => /<[a-z][\s\S]*?>/i.test(value);

const wrapPlain = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (hasTags(text)) return text;
    return text
        .split(/\n{2,}/)
        .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
        .join('');
};

const mediaTypeOf = (url) => {
    const clean = String(url).split(/[?#]/)[0].toLowerCase();
    if (clean.endsWith('.gif')) return 'gif';
    if (/\.(png|jpe?g|webp|avif)$/.test(clean)) return 'image';
    return null;
};

const filter = {
    $or: [{ title: { $exists: true } }, { featured_image: { $exists: true } }],
};

const total = db.posts.countDocuments(filter);
let titlesMerged = 0;
let titlesEmpty = 0;
let mediaConverted = 0;
let mediaSkipped = 0;
const ops = [];

db.posts.find(filter).forEach((post) => {
    const set = {};
    const unset = {};

    if (Object.prototype.hasOwnProperty.call(post, 'title')) {
        const title = String(post.title ?? '').trim();
        if (title) {
            set.content_text = `<p><strong>${escapeHtml(title)}</strong></p>${wrapPlain(post.content_text)}`;
            titlesMerged += 1;
        } else {
            const wrapped = wrapPlain(post.content_text);
            if (wrapped !== String(post.content_text ?? '')) {
                set.content_text = wrapped;
            }
            titlesEmpty += 1;
        }
        unset.title = '';
    }

    if (Object.prototype.hasOwnProperty.call(post, 'featured_image')) {
        const url = post.featured_image;
        const type =
            typeof url === 'string' && url.startsWith('/uploads/')
                ? mediaTypeOf(url)
                : null;
        if (!url) {
            unset.featured_image = '';
        } else if (type) {
            if (!Array.isArray(post.media) || post.media.length === 0) {
                set.media = [{ id: 'legacy', type, url }];
            }
            unset.featured_image = '';
            mediaConverted += 1;
        } else {
            mediaSkipped += 1;
        }
    }

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (Object.keys(update).length) {
        ops.push({ updateOne: { filter: { _id: post._id }, update } });
    }
});

print(`posts to process: ${total}`);
print(`titles merged into content: ${titlesMerged}`);
print(`posts with an empty title (title field removed): ${titlesEmpty}`);
print(`featured_image converted to media: ${mediaConverted}`);
print(`featured_image skipped (not a stored upload path): ${mediaSkipped}`);

if (apply) {
    let modified = 0;
    for (let i = 0; i < ops.length; i += 500) {
        modified += db.posts.bulkWrite(ops.slice(i, i + 500)).modifiedCount;
    }
    print(`posts updated: ${modified}`);
} else {
    print(`dry run, ${ops.length} updates pending (set APPLY = true to apply)`);
}
