"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const http = __importStar(require("@actions/http-client"));
const auth = __importStar(require("@actions/http-client/auth"));
const file_url_1 = __importDefault(require("file-url"));
const fs = __importStar(require("fs"));
const jsonschema = __importStar(require("jsonschema"));
const path = __importStar(require("path"));
const zlib_1 = __importDefault(require("zlib"));
const fingerprints = __importStar(require("./fingerprints"));
const sharedEnv = __importStar(require("./shared-environment"));
const util = __importStar(require("./util"));
// Takes a list of paths to sarif files and combines them together,
// returning the contents of the combined sarif file.
function combineSarifFiles(sarifFiles) {
    let combinedSarif = {
        version: null,
        runs: []
    };
    for (let sarifFile of sarifFiles) {
        let sarifObject = JSON.parse(fs.readFileSync(sarifFile, 'utf8'));
        // Check SARIF version
        if (combinedSarif.version === null) {
            combinedSarif.version = sarifObject.version;
        }
        else if (combinedSarif.version !== sarifObject.version) {
            throw "Different SARIF versions encountered: " + combinedSarif.version + " and " + sarifObject.version;
        }
        combinedSarif.runs.push(...sarifObject.runs);
    }
    return JSON.stringify(combinedSarif);
}
exports.combineSarifFiles = combineSarifFiles;
// Upload the given payload.
// If the request fails then this will retry a small number of times.
async function uploadPayload(payload) {
    core.info('Uploading results');
    // If in test mode we don't want to upload the results
    const testMode = process.env['TEST_MODE'] === 'true' || false;
    if (testMode) {
        return true;
    }
    const githubToken = core.getInput('token');
    const ph = new auth.BearerCredentialHandler(githubToken);
    const client = new http.HttpClient('Code Scanning : Upload SARIF', [ph]);
    const url = 'https://api.github.com/repos/' + process.env['GITHUB_REPOSITORY'] + '/code-scanning/analysis';
    // Make up to 4 attempts to upload, and sleep for these
    // number of seconds between each attempt.
    // We don't want to backoff too much to avoid wasting action
    // minutes, but just waiting a little bit could maybe help.
    const backoffPeriods = [1, 5, 15];
    for (let attempt = 0; attempt <= backoffPeriods.length; attempt++) {
        const res = await client.put(url, payload);
        core.debug('response status: ' + res.message.statusCode);
        const statusCode = res.message.statusCode;
        if (statusCode === 202) {
            core.info("Successfully uploaded results");
            return true;
        }
        const requestID = res.message.headers["x-github-request-id"];
        // On any other status code that's not 5xx mark the upload as failed
        if (!statusCode || statusCode < 500 || statusCode >= 600) {
            core.setFailed('Upload failed (' + requestID + '): (' + statusCode + ') ' + await res.readBody());
            return false;
        }
        // On a 5xx status code we may retry the request
        if (attempt < backoffPeriods.length) {
            // Log the failure as a warning but don't mark the action as failed yet
            core.warning('Upload attempt (' + (attempt + 1) + ' of ' + (backoffPeriods.length + 1) +
                ') failed (' + requestID + '). Retrying in ' + backoffPeriods[attempt] +
                ' seconds: (' + statusCode + ') ' + await res.readBody());
            // Sleep for the backoff period
            await new Promise(r => setTimeout(r, backoffPeriods[attempt] * 1000));
            continue;
        }
        else {
            // If the upload fails with 5xx then we assume it is a temporary problem
            // and not an error that the user has caused or can fix.
            // We avoid marking the job as failed to avoid breaking CI workflows.
            core.error('Upload failed (' + requestID + '): (' + statusCode + ') ' + await res.readBody());
            return false;
        }
    }
    return false;
}
// Uploads a single sarif file or a directory of sarif files
// depending on what the path happens to refer to.
// Returns true iff the upload occurred and succeeded
async function upload(input) {
    if (fs.lstatSync(input).isDirectory()) {
        const sarifFiles = fs.readdirSync(input)
            .filter(f => f.endsWith(".sarif"))
            .map(f => path.resolve(input, f));
        if (sarifFiles.length === 0) {
            core.setFailed("No SARIF files found to upload in \"" + input + "\".");
            return false;
        }
        return await uploadFiles(sarifFiles);
    }
    else {
        return await uploadFiles([input]);
    }
}
exports.upload = upload;
// Counts the number of results in the given SARIF file
function countResultsInSarif(sarif) {
    let numResults = 0;
    for (const run of JSON.parse(sarif).runs) {
        numResults += run.results.length;
    }
    return numResults;
}
exports.countResultsInSarif = countResultsInSarif;
// Validates that the given file path refers to a valid SARIF file.
// Returns a non-empty list of error message if the file is invalid,
// otherwise returns the empty list if the file is valid.
function validateSarifFileSchema(sarifFilePath) {
    const sarif = JSON.parse(fs.readFileSync(sarifFilePath, 'utf8'));
    const schema = JSON.parse(fs.readFileSync(__dirname + '/../src/sarif_v2.1.0_schema.json', 'utf8'));
    const result = new jsonschema.Validator().validate(sarif, schema);
    if (result.valid) {
        return true;
    }
    else {
        // Set the failure message to the stacks of all the errors.
        // This should be of a manageable size and may even give enough to fix the error.
        const errorMessages = result.errors.map(e => "- " + e.stack);
        core.setFailed("Unable to upload \"" + sarifFilePath + "\" as it is not valid SARIF:\n" + errorMessages.join("\n"));
        // Also output the more verbose error messages in groups as these may be very large.
        for (const error of result.errors) {
            core.startGroup("Error details: " + error.stack);
            core.info(JSON.stringify(error, null, 2));
            core.endGroup();
        }
        return false;
    }
}
exports.validateSarifFileSchema = validateSarifFileSchema;
// Uploads the given set of sarif files.
// Returns true iff the upload occurred and succeeded
async function uploadFiles(sarifFiles) {
    core.startGroup("Uploading results");
    core.info("Uploading sarif files: " + JSON.stringify(sarifFiles));
    const sentinelEnvVar = "CODEQL_UPLOAD_SARIF";
    if (process.env[sentinelEnvVar]) {
        core.error("Aborting upload: only one run of the codeql/analyze or codeql/upload-sarif actions is allowed per job");
        return false;
    }
    core.exportVariable(sentinelEnvVar, sentinelEnvVar);
    // Validate that the files we were asked to upload are all valid SARIF files
    for (const file of sarifFiles) {
        if (!validateSarifFileSchema(file)) {
            return false;
        }
    }
    const commitOid = await util.getCommitOid();
    const workflowRunIDStr = util.getRequiredEnvParam('GITHUB_RUN_ID');
    const ref = util.getRef();
    const analysisKey = await util.getAnalysisKey();
    const analysisName = util.getRequiredEnvParam('GITHUB_WORKFLOW');
    const startedAt = process.env[sharedEnv.CODEQL_ACTION_STARTED_AT];
    let sarifPayload = combineSarifFiles(sarifFiles);
    sarifPayload = fingerprints.addFingerprints(sarifPayload);
    const zipped_sarif = zlib_1.default.gzipSync(sarifPayload).toString('base64');
    let checkoutPath = core.getInput('checkout_path');
    let checkoutURI = file_url_1.default(checkoutPath);
    const workflowRunID = parseInt(workflowRunIDStr, 10);
    if (Number.isNaN(workflowRunID)) {
        core.setFailed('GITHUB_RUN_ID must define a non NaN workflow run ID');
        return false;
    }
    let matrix = core.getInput('matrix');
    if (matrix === "null" || matrix === "") {
        matrix = undefined;
    }
    const toolNames = util.getToolNames(sarifPayload);
    const payload = JSON.stringify({
        "commit_oid": commitOid,
        "ref": ref,
        "analysis_key": analysisKey,
        "analysis_name": analysisName,
        "sarif": zipped_sarif,
        "workflow_run_id": workflowRunID,
        "checkout_uri": checkoutURI,
        "environment": matrix,
        "started_at": startedAt,
        "tool_names": toolNames,
    });
    // Log some useful debug info about the info
    core.debug("Raw upload size: " + sarifPayload.length + " bytes");
    core.debug("Base64 zipped upload size: " + zipped_sarif.length + " bytes");
    core.debug("Number of results in upload: " + countResultsInSarif(sarifPayload));
    // Make the upload
    const succeeded = await uploadPayload(payload);
    core.endGroup();
    return succeeded;
}
//# sourceMappingURL=upload-lib.js.map