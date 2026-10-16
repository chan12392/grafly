/** Shared query intent and path policy for candidate retrieval and ranking. */
export function isTestPath(path) {
    return /(^|\/)(tests?|__tests__|spec)\/|(_test|\.test|\.spec)\.[a-z]+$|(^|\/)(test_[^/]+|conftest)\.py$/i.test(path || "");
}

export function queryWantsTests(query) {
    return /\b(tests?|specs?|coverage|assert(?:ion)?s?|fixtures?|mocks?)\b/i.test(query);
}
