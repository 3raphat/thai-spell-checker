import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "thai-spelling-check" is now active!');

	const disposable = vscode.commands.registerCommand('thai-spelling-check.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from thai-spelling-check!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
