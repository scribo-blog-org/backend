const apply = typeof APPLY !== 'undefined' && APPLY === true;

const withCategory = db.posts.countDocuments({ category: { $exists: true } });
const categories = db.getCollectionNames().includes('categories')
    ? db.categories.countDocuments({})
    : 0;
const searchLogs = db.search_queries.countDocuments({
    categories: { $exists: true },
});

print(`posts with a category field: ${withCategory}`);
print(`categories documents: ${categories}`);
print(`search_queries with a categories counter: ${searchLogs}`);

if (apply) {
    const posts = db.posts.updateMany(
        { category: { $exists: true } },
        { $unset: { category: '' } },
    );
    const search = db.search_queries.updateMany(
        { categories: { $exists: true } },
        { $unset: { categories: '' } },
    );
    if (db.getCollectionNames().includes('categories')) {
        db.categories.drop();
    }
    print(
        `posts updated ${posts.modifiedCount}, search_queries updated ${search.modifiedCount}, categories dropped`,
    );
} else {
    print('dry run, nothing changed (set APPLY = true to apply)');
}
