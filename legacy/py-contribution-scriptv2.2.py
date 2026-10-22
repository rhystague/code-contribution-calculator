import subprocess
import csv
import sys
import os
from collections import defaultdict

def run_command(command):
    return subprocess.check_output(command, shell=True, text=True).strip()

def get_unique_authors(authors):
    email_map = {}
    for author in authors:
        if '<' in author and '>' in author:
            name, email = author.split('<')
            email = email.strip('>')
            name = name.strip()
            if email not in email_map:
                email_map[email] = f'{name} <{email}>'
    return list(email_map.values())

def calculate_additions_and_deletions(author_stats):
    additions = deletions = 0
    for line in author_stats.splitlines():
        if any(skip in line for skip in ['node_modules', 'package-lock.json', 'devcontainer']):
            continue
        parts = line.split('\t')
        if len(parts) >= 2:
            try:
                added = int(parts[0])
                deleted = int(parts[1])
                additions += added
                deletions += deleted
            except ValueError:
                continue
    return additions, deletions

def pad_string(s, width):
    return str(s).ljust(width)

def get_git_contributions():
    try:
        authors_log = run_command('git log --pretty=format:"%an <%ae>"')
        authors = list(set(authors_log.splitlines()))
        unique_authors = get_unique_authors(authors)

        contributions = {}
        total_net = 0
        total_commits = 0

        # Detect the main branch
        try:
            branch = run_command("git branch -l main master --format '%(refname:short)'")
        except subprocess.CalledProcessError:
            branch = "main"

        for author_info in unique_authors:
            if not author_info.strip():
                continue
            name, email = author_info.split('<')
            email = email.strip('>')

            stats_command = f'git log {branch} --author="{email}" --pretty=tformat: --numstat'
            author_stats = run_command(stats_command)
            additions, deletions = calculate_additions_and_deletions(author_stats)
            net = max(0, additions - deletions)
            total_net += net

            commits_command = f'git log {branch} --author="{email}" --pretty=tformat:"%H" | wc -l'
            commit_count = int(run_command(commits_command))
            total_commits += commit_count

            contributions[email] = {
                'authorName': name.strip(),
                'email': email,
                'additions': additions,
                'deletions': deletions,
                'netContribution': net,
                'commitCount': commit_count
            }

        return contributions, total_net, total_commits
    except subprocess.CalledProcessError as e:
        print(f"Error executing git command: {e}")
        return None, 0, 0

def write_csv(filename, contributions, total_net, total_commits):
    headers = ['Author', 'Email', 'Added', 'Removed', 'Net', 'Commits', 'Net Cont. (%)']
    with open(filename, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(headers)

        for stats in contributions.values():
            net_pct = (stats['netContribution'] / total_net * 75) if total_net else 0
            commit_pct = (stats['commitCount'] / total_commits * 25) if total_commits else 0
            combined_pct = round(net_pct + commit_pct, 2)
            writer.writerow([
                stats['authorName'],
                stats['email'],
                stats['additions'],
                stats['deletions'],
                stats['netContribution'],
                stats['commitCount'],
                f'{combined_pct}%'
            ])
        writer.writerow(['TOTAL', '', '', '', total_net, total_commits, ''])

def print_contributions(contributions, total_net, total_commits):
    headers = ['Author', 'Email', 'Added', 'Removed', 'Net', 'Commits', 'Net Cont. (%)']
    widths = [30, 60, 10, 10, 10, 10, 15]

    def format_row(values):
        return ''.join(pad_string(v, w) for v, w in zip(values, widths))

    print(format_row(headers))
    print('-' * sum(widths))

    for stats in contributions.values():
        net_pct = (stats['netContribution'] / total_net * 75) if total_net else 0
        commit_pct = (stats['commitCount'] / total_commits * 25) if total_commits else 0
        combined_pct = round(net_pct + commit_pct, 2)
        row = [
            stats['authorName'],
            stats['email'],
            str(stats['additions']),
            str(stats['deletions']),
            str(stats['netContribution']),
            str(stats['commitCount']),
            f'{combined_pct}%'
        ]
        print(format_row(row))

    print('-' * sum(widths))
    total_row = ['TOTAL', '', '', '', str(total_net), str(total_commits), '']
    print(format_row(total_row))

def main():
    no_csv = '--no-csv' in sys.argv
    prefix = sys.argv[2] if len(sys.argv) > 2 else ''
    filename = f"{prefix}-contribution-summary.csv" if prefix else "contribution-summary.csv"

    contributions, total_net, total_commits = get_git_contributions()
    if contributions:
        print_contributions(contributions, total_net, total_commits)
        if not no_csv:
            write_csv(filename, contributions, total_net, total_commits)
            print(f"\nContribution summary written to {filename}")

if __name__ == "__main__":
    main()
