import { execSync } from 'child_process';
import fs from 'fs';

function getGitContributions() {
    try {
        // Get all authors' names and emails from the git log
        const authorsLog = execSync('git log --pretty=format:"%an <%ae>"').toString();
        const authors = [...new Set(authorsLog.split('\n'))]; // Get unique name and email pairs

        const uniqueAuthors = getUniqueAuthors(authors);
        const contributions = {};
        let totalNetContributions = 0;
        let totalCommits = 0;

        uniqueAuthors.forEach(authorInfo => {
            if (authorInfo.trim() === '') return;

            const [authorName, authorEmail] = authorInfo.split(' <');
            const email = authorEmail.slice(0, -1); // Remove trailing '>'

            // Get the total number of lines added and removed by the author
            const branch = execSync(`git branch -l main master --format '%(refname:short)'`).toString().trim();
            const authorStatsCommand = `git log ${branch} --author="${email}" --pretty=tformat: --numstat`;
            const authorStats = execSync(authorStatsCommand).toString();

            const { additions, deletions } = calculateAdditionsAndDeletions(authorStats);
            const netContribution = (additions - deletions) < 0 ? 0 : (additions - deletions);
            totalNetContributions += netContribution;

            // Get the number of commits by the author
            const commitCountCommand = `git log ${branch} --author="${email}" --pretty=tformat:"%H" | wc -l`;
            const commitCount = parseInt(execSync(commitCountCommand).toString(), 10);
            totalCommits += commitCount;

            contributions[email] = {
                authorName,
                email,
                additions,
                deletions,
                netContribution,
                commitCount,
            };
        });

        return { contributions, totalNetContributions, totalCommits };
    } catch (error) {
        console.error('Error executing git command:', error);
        return null;
    }
}

function getUniqueAuthors(authors) {
    const emailMap = new Map();

    authors.forEach(author => {
        const match = author.match(/(.+?)\s*<([^>]+)>/);
        if (match) {
            const [_, authorName, authorEmail] = match;
            if (!emailMap.has(authorEmail)) {
                emailMap.set(authorEmail, `${authorName.trim()} <${authorEmail}>`);
            }
        }
    });
    return Array.from(emailMap.values());
}

function calculateAdditionsAndDeletions(authorStats) {
    let additions = 0;
    let deletions = 0;

    authorStats.split('\n').forEach(line => {
        if (line.includes('node_modules') || line.includes('package-lock.json') ||
            line.includes('devcontainer')) return;

        const parts = line.split('\t');
        if (parts.length >= 2) {
            const added = parseInt(parts[0], 10);
            const deleted = parseInt(parts[1], 10);

            if (!isNaN(added)) additions += added;
            if (!isNaN(deleted)) deletions += deleted;
        }
    });

    return { additions, deletions };
}

function padString(str, length) {
    return str.padEnd(length, ' ');
}

function writeCSV(filename, contributions, totalNetContributions, totalCommits) {
    const headers = ['Author', 'Email', 'Added', 'Removed', 'Net', 'Commits', 'Net Cont. (%)'];
    const rows = [headers.join(',')];

    for (const stats of Object.values(contributions)) {
        const contributionPercentage = ((stats.netContribution / totalNetContributions) * 75).toFixed(2);
        const commitPercentage = ((stats.commitCount / totalCommits) * 25).toFixed(2);
        const combinedPercentage = (parseFloat(contributionPercentage) + parseFloat(commitPercentage)).toFixed(2);
        const row = [
            stats.authorName,
            `"${stats.email}"`,
            stats.additions,
            stats.deletions,
            stats.netContribution,
            stats.commitCount,
            `${combinedPercentage}%`
        ];
        rows.push(row.join(','));
    }

    rows.push(`TOTAL,,,,${totalNetContributions},${totalCommits},`);
    fs.writeFileSync(filename, rows.join('\n'));
}

function printContributions(contributions, totalNetContributions, totalCommits) {
    const headers = ['Author', 'Email', 'Added', 'Removed', 'Net', 'Commits', 'Net Cont. (%)'];
    const columnWidths = [30, 70, 10, 10, 10, 10, 10];

    // Print header
    console.log(headers.map((header, index) => padString(header, columnWidths[index])).join(''));
    console.log('-'.repeat(columnWidths.reduce((totalColumnWidth, columnWidth) => totalColumnWidth + columnWidth, 0)));

    // Print each author's contributions
    for (const stats of Object.values(contributions)) {
        const contributionPercentage = ((stats.netContribution / totalNetContributions) * 75).toFixed(2);
        const commitPercentage = ((stats.commitCount / totalCommits) * 25).toFixed(2);
        const combinedPercentage = (parseFloat(contributionPercentage) + parseFloat(commitPercentage)).toFixed(2);
        const row = [
            padString(stats.authorName, columnWidths[0]),
            padString(stats.email, columnWidths[1]),
            padString(stats.additions.toString(), columnWidths[2]),
            padString(stats.deletions.toString(), columnWidths[3]),
            padString(stats.netContribution.toString(), columnWidths[4]),
            padString(stats.commitCount.toString(), columnWidths[5]),
            padString(`${combinedPercentage}%`, columnWidths[6])
        ];
        console.log(row.join(''));
    }

    // Print total net and total commits
    console.log('-'.repeat(columnWidths.reduce((totalColumnWidth, columnWidth) => totalColumnWidth + columnWidth, 0)));
    const totalRow = [
        padString('TOTAL', columnWidths[0]),
        padString('', columnWidths[1]),
        padString('', columnWidths[2]),
        padString('', columnWidths[3]),
        padString(totalNetContributions.toString(), columnWidths[4]),
        padString(totalCommits.toString(), columnWidths[5]),
        padString('', columnWidths[6])
    ];
    console.log(totalRow.join(''));
}

function main() {
    const noCSV = process.argv.includes('--no-csv');

    const result = getGitContributions();
    if (result) {
        const { contributions, totalNetContributions, totalCommits } = result;
        printContributions(contributions, totalNetContributions, totalCommits);
        if (!noCSV) {
            const prefix = process.argv[2] ? `${process.argv[2]}-` : '';
            const filename = `${prefix}contribution-summary.csv`;
            writeCSV(filename, contributions, totalNetContributions, totalCommits);
            console.log(`Contribution summary written to ${filename}`);
        }
    }
}

main();