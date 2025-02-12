import type { BaseOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import type { AgentExecutorInput } from 'langchain/agents';
import { AgentExecutor, OpenAIAgent } from 'langchain/agents';
import { BufferMemory, type BaseChatMemory } from 'langchain/memory';
import { CombiningOutputParser } from 'langchain/output_parsers';
import {
	type IExecuteFunctions,
	type INodeExecutionData,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';

import { getConnectedTools, getPromptInputByType } from '@utils/helpers';
import { getOptionalOutputParsers } from '@utils/output_parsers/N8nOutputParser';
import { getTracingConfig } from '@utils/tracing';

import { extractParsedOutput } from '../utils';

export async function openAiFunctionsAgentExecute(
	this: IExecuteFunctions,
	nodeVersion: number,
): Promise<INodeExecutionData[][]> {
	this.logger.debug('Executing OpenAi Functions Agent');
	const model = await this.getAIModel<ChatOpenAI>();

	if (!(model instanceof ChatOpenAI)) {
		throw new NodeOperationError(
			this.getNode(),
			'OpenAI Functions Agent requires OpenAI Chat Model',
		);
	}
	const memory = (await this.getInputConnectionData(NodeConnectionType.AiMemory, 0)) as
		| BaseChatMemory
		| undefined;
	const tools = await getConnectedTools(this, nodeVersion >= 1.5, false);
	const outputParsers = await getOptionalOutputParsers(this);
	const options = this.getNodeParameter('options', 0, {}) as {
		systemMessage?: string;
		maxIterations?: number;
		returnIntermediateSteps?: boolean;
	};

	const agentConfig: AgentExecutorInput = {
		tags: ['openai-functions'],
		agent: OpenAIAgent.fromLLMAndTools(model, tools, {
			prefix: options.systemMessage,
		}),
		tools,
		maxIterations: options.maxIterations ?? 10,
		returnIntermediateSteps: options?.returnIntermediateSteps === true,
		memory:
			memory ??
			new BufferMemory({
				returnMessages: true,
				memoryKey: 'chat_history',
				inputKey: 'input',
				outputKey: 'output',
			}),
	};

	const agentExecutor = AgentExecutor.fromAgentAndTools(agentConfig);

	const returnData: INodeExecutionData[] = [];

	let outputParser: BaseOutputParser | undefined;
	let prompt: PromptTemplate | undefined;
	if (outputParsers.length) {
		outputParser =
			outputParsers.length === 1 ? outputParsers[0] : new CombiningOutputParser(...outputParsers);

		const formatInstructions = outputParser.getFormatInstructions();

		prompt = new PromptTemplate({
			template: '{input}\n{formatInstructions}',
			inputVariables: ['input'],
			partialVariables: { formatInstructions },
		});
	}

	const items = this.getInputData();
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			let input;
			if (this.getNode().typeVersion <= 1.2) {
				input = this.getNodeParameter('text', itemIndex) as string;
			} else {
				input = getPromptInputByType({
					ctx: this,
					i: itemIndex,
					inputKey: 'text',
					promptTypeKey: 'promptType',
				});
			}

			if (input === undefined) {
				throw new NodeOperationError(this.getNode(), 'The ‘text‘ parameter is empty.');
			}

			if (prompt) {
				input = (await prompt.invoke({ input })).value;
			}

			const response = await agentExecutor
				.withConfig(getTracingConfig(this))
				.invoke({ input, outputParsers });

			if (outputParser) {
				response.output = await extractParsedOutput(this, outputParser, response.output as string);
			}

			returnData.push({ json: response });
		} catch (error) {
			if (this.continueOnFail()) {
				returnData.push({ json: { error: error.message }, pairedItem: { item: itemIndex } });
				continue;
			}

			throw error;
		}
	}

	return [returnData];
}
