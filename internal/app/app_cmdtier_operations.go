package app

import "strings"

func classifyTruncate(c *segmentCtx) {
	classifyWriteTarget(c)
	for _, token := range c.operands() {
		if !looksLikePath(token.Text) {
			continue
		}
		c.add(tierBounded, riskDestructive, "truncates a file", classifyTargetPath(token.Text).Display, &token)
	}
}

func classifyCriticalFirewall(c *segmentCtx) {
	if c.verb == "ufw" && (c.subcommand() == "allow" || c.subcommand() == "limit") {
		c.add(tierBounded, riskExposure, "changes network exposure", c.joinedArgs(), nil)
		return
	}
	if c.verb == "ufw" && (c.subcommand() == "status" || c.subcommand() == "show") || len(c.args) == 1 && (c.args[0].Text == "--state" || strings.HasPrefix(c.args[0].Text, "--list-")) {
		c.add(tierObserve, riskObserve, "lists firewall rules", c.joinedArgs(), nil)
		return
	}
	c.add(tierCritical, riskSelfLock, "changes firewall rules which can cut access", c.joinedArgs(), nil)
}

func classifyCriticalSignal(c *segmentCtx) {
	for _, arg := range c.args {
		if arg.Text == "-1" || arg.Text == "0" {
			c.add(tierCritical, riskSelfLock, "signals all accessible processes or a process group", arg.Text, &arg)
			return
		}
		for _, name := range criticalServiceNames {
			if strings.EqualFold(arg.Text, name) {
				c.add(tierCritical, riskSelfLock, "signals an access-critical service", arg.Text, &arg)
				return
			}
		}
	}
	if c.hasFlag("-f", "--full", "--all") {
		c.add(tierBounded, riskUndecidable, "process selection cannot be bounded statically", c.joinedArgs(), nil)
		return
	}
	c.add(tierBounded, riskDestructive, "signals processes", c.joinedArgs(), nil)
}

func classifyUserModification(c *segmentCtx) {
	if c.hasFlag("-L", "--lock", "-p", "--password", "-s", "--shell", "-e", "--expiredate") {
		c.add(tierCritical, riskSelfLock, "changes account authentication or login access", c.joinedArgs(), nil)
		return
	}
	c.add(tierBounded, riskDestructive, "changes a user account", c.joinedArgs(), nil)
}

func classifyCryptsetup(c *segmentCtx) {
	switch strings.ToLower(c.subcommand()) {
	case "luksformat", "erase", "lukserase", "reencrypt":
		target := c.joinedArgs()
		operands := c.operands()
		if len(operands) > 1 {
			target = operands[len(operands)-1].Text
		}
		c.add(tierCritical, riskIrreversible, "destroys encrypted storage", target, nil)
	case "status", "luksdump", "isluks":
		c.add(tierObserve, riskObserve, "reads encrypted storage status", c.joinedArgs(), nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised encrypted storage operation", c.joinedArgs(), nil)
	}
}
