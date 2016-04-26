"use babel";

import { CompositeDisposable } from "atom";

let subscriptions, goconfig;
let editors, output, panel, store, commands;
let initialState, dependenciesInstalled, path;
let cmds;

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
		path = null;
	},
	serialize() {
		return store ? store.serialize() : initialState;
	},

	start() {
		if (!dependenciesInstalled || !path) {
			return;
		}

		// load all dependencies once after everything is ready
		// this reduces the initial load time of this package
		commands = require("./commands");

		store = require("./store");
		store.init(initialState);
		store.store.dispatch({ type: "SET_DLV_PATH", path: path });

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

		// start observing config values
		subscriptions.add(
			atom.config.observe("gdb-debug.limitCommandsToGo", this.observeCommandsLimit.bind(this))
		);
	},
	observeCommandsLimit(limitCommandsToGo) {
		if (cmds) {
			subscriptions.remove(cmds);
			cmds.dispose();
		}

		let selector = "atom-text-editor";
		if (limitCommandsToGo === true) {
			selector = "atom-text-editor[data-grammar~='go']";
		}
		cmds = atom.commands.add(selector, commands.getKeyboardCommands());
		subscriptions.add(cmds);
	}
};
