// Shared progression for Vault Heist: day key, ranks and badges.
export const today = () => new Date().toISOString().slice(0, 10);
export const tactic = () => ({ name: "Spoofed signals" });
export const RANKS = [[0, "Lookout"], [400, "Lockpick"], [1500, "Safecracker"], [4000, "Ghost"], [10000, "Mastermind"]];
export const rank = xp => RANKS.filter(([n]) => xp >= n).pop()[1];
export const BADGES = { first: "First heist", code: "The contract held", crack: "Cracked the vault" };
