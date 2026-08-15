export function pascalFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join("");
}

export function titleFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
}

export function assertSlug(slug: string, label: string): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new Error(`${label} must be kebab-case: ${slug}`);
	}
	return slug;
}
