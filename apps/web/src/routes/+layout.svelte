<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta
		name="description"
		content="Play chess blindfolded with your friends using voice or typed moves."
	/>
</svelte:head>
{@render children()}
