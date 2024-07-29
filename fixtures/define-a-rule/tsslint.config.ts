import { defineConfig } from '@tsslint/config';

export default defineConfig({
	debug: true,
	exclude: ['exclude.ts'],
	include: ['fixture.ts'],
	rules: {
		'no-console': (await import('../noConsoleRule')).create(),
	},
});
