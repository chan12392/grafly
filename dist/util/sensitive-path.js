/** Paths whose contents must stay out of indexes and comparison feeds. */
export function isSensitivePath(path) {
    return /(?:^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials?(?:[._-][^\\/]*)?|passwords?(?:[._-][^\\/]*)?|secrets?(?:[._-][^\\/]*)?|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.ssh|\.aws|\.kube|model-access|id_[^\\/]+)(?:[\\/]|$)/i.test(path)
        || /(?:^|[\\/])gh[\\/]hosts\.ya?ml$/i.test(path)
        || /\.(?:pem|key|p12|pfx)$/i.test(path);
}
