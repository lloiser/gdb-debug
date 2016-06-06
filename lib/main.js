"use babel";

import { CompositeDisposable } from "atom";

let subscriptions;
let editors, output, panel, store, commands;
let initialState, dependenciesInstalled;

export default {
	activate(state) {
		initialState = state;

		require("atom-package-deps").install("gdb-debug").then(() => {
			dependenciesInstalled = true;
			this.start();
			return true;
		}).catch((e) => {
			console.log(e);
		});
	},
	deactivate() {
		if (subscriptions) {
			subscriptions.dispose();
			subscriptions = null;
		}
		dependenciesInstalled = false;
	},
	serialize() {
		return store ? store.serialize() : initialState;
	},

	start() {
		if (!dependenciesInstalled) {
			return;
		}

		// load all dependencies once after everything is ready
		// this reduces the initial load time of this package
		commands = require("./commands");

		store = require("./store");
		store.init(initialState);

		require("./gdb");
		editors = require("./editors");
		panel = require("./panel.jsx");
		output = require("./output.jsx");

		panel.init();
		editors.init();
		output.init();

		subscriptions = new CompositeDisposable(
			atom.commands.add("atom-workspace", {
				"gdb-debug:toggle-panel": commands.get("toggle-panel").action
			}),
			store,
			editors,
			panel,
			output
		);
	},

	provideDebug() {
		return {
			runGdb: require("./gdb").runGdb
		};
	}
};
